import { decideAccess } from "@/core/access";
import { admissionBlock } from "@/core/models/admission";
import {
  attendanceIdFor,
  blockOutcome,
  foodCollectionIdFor,
  memberKeyFor,
  type MealType,
  type ScanMember,
  type ScanOutcome,
} from "@/core/models/attendance";
import { maskEmail } from "@/core/models/registration";
import type { Permission } from "@/core/permissions";
import { ApiError, type Caller } from "./api";
import { COLLECTIONS, FieldValue, adminDb } from "./firebase-admin";
import { compact, toDates } from "./serialize";

/**
 * The gate, on the server.
 *
 * A volunteer used to scan by reading the event's full registration records into the phone and writing the check-in
 * from there. That put every attendee's email, phone number, college and answers on a volunteer's device, and let any
 * volunteer of the fest read the lot. Now the volunteer's phone is sent only what the gate needs - a name, a ticket
 * code, who is on the entry, whether it is admissible, and who has already been ticked off - and every check-in and
 * meal is recorded here, after checking that this volunteer has the duty and the sub-event.
 *
 * What a volunteer is sent per entry never includes an email address (a masked form is shown for telling two people
 * apart), a phone number, a college, a student id or a registration answer. The member `key` is what the device uses to
 * tick people off; it is derived from the email here, where the email is known.
 */

export interface GateEvent {
  id: string;
  festId: string;
  title: string;
  mealSlots: unknown[];
}

export const loadGateEvent = async (eventId: string): Promise<GateEvent> => {
  const snapshot = await adminDb().collection(COLLECTIONS.events).doc(eventId).get();
  if (!snapshot.exists) throw ApiError.notFound("No such competition.");
  const data = snapshot.data() ?? {};
  return { id: snapshot.id, festId: String(data.festId ?? ""), title: String(data.title ?? ""), mealSlots: Array.isArray(data.mealSlots) ? data.mealSlots : [] };
};

/** Does this caller hold this permission on this sub-event, through whichever route they have it? */
const may = (caller: Caller, event: GateEvent, permission: Permission): boolean => decideAccess(caller, event.festId, { permission, eventId: event.id }).ok;

/**
 * The caller must be on the gate for this sub-event with the named duty - entry for check-ins, meal for meals - or be
 * an admin, coordinator or the Event Head with that power here. Anything else is refused, and says nothing about whether
 * the event or ticket exists.
 */
export const requireGateDuty = (caller: Caller, event: GateEvent, permission: "attendance:scan" | "meal:scan"): void => {
  if (!may(caller, event, permission)) throw ApiError.forbidden("You are not assigned to this duty at this competition.");
};

/* ───────────── what a volunteer is sent ───────────── */

interface RegistrationLike {
  id: string;
  eventId: string;
  festId: string;
  userId: string;
  userName: string;
  userEmail: string;
  ticketCode: string;
  teamName?: string;
  status?: string;
  paymentStatus?: string;
  members: Array<{ name: string; email: string }>;
}

const asRegistration = (id: string, data: Record<string, unknown>): RegistrationLike => ({
  id,
  eventId: String(data.eventId ?? ""),
  festId: String(data.festId ?? ""),
  userId: String(data.userId ?? ""),
  userName: String(data.userName ?? ""),
  userEmail: String(data.userEmail ?? ""),
  ticketCode: String(data.ticketCode ?? ""),
  ...(data.teamName ? { teamName: String(data.teamName) } : {}),
  ...(typeof data.status === "string" ? { status: data.status } : {}),
  ...(typeof data.paymentStatus === "string" ? { paymentStatus: data.paymentStatus } : {}),
  members: Array.isArray(data.members) ? (data.members as Array<{ name?: unknown; email?: unknown }>).map((m) => ({ name: String(m.name ?? ""), email: String(m.email ?? "") })) : [],
});

/** Everyone on the entry; a solo ticket stands for its one holder. */
const rosterOf = (reg: RegistrationLike): Array<{ name: string; email: string }> => (reg.members.length ? reg.members : [{ name: reg.userName, email: reg.userEmail }]);

export interface GateRosterEntry {
  ticketCode: string;
  registrationId: string;
  eventId: string;
  festId: string;
  userName: string;
  teamName?: string;
  memberCount: number;
  status: string;
  paymentStatus?: string;
  members: Array<{ key: string; name: string; email: string }>;
  search: string;
}

const projectEntry = (reg: RegistrationLike): GateRosterEntry => {
  const members = rosterOf(reg).map((m) => ({ key: memberKeyFor(m.email), name: m.name, email: maskEmail(m.email) }));
  return {
    ticketCode: reg.ticketCode,
    registrationId: reg.id,
    eventId: reg.eventId,
    festId: reg.festId,
    userName: reg.userName,
    ...(reg.teamName ? { teamName: reg.teamName } : {}),
    memberCount: members.length,
    status: reg.status ?? "confirmed",
    ...(reg.paymentStatus && reg.paymentStatus !== "not_required" ? { paymentStatus: reg.paymentStatus } : {}),
    members,
    // Everything manual search matches on, flattened once so a lookup at the gate is a substring test over cached text.
    // Names, ticket code and team only: never an email, phone or college.
    search: [reg.id, reg.ticketCode, reg.teamName, reg.userName, ...members.map((m) => m.name)].filter(Boolean).join(" ").toLowerCase(),
  };
};

export interface GateRoster {
  event: { id: string; festId: string; title: string };
  roster: GateRosterEntry[];
  checkins: Array<{ registrationId: string; at: number; members: string[] }>;
  meals: Array<{ registrationId: string; servedOn: string; mealType: string; served: number; members: string[] }>;
}

export const buildRoster = async (caller: Caller, event: GateEvent): Promise<GateRoster> => {
  const mayEnter = may(caller, event, "attendance:scan");
  const mayServe = may(caller, event, "meal:scan");
  if (!mayEnter && !mayServe) throw ApiError.forbidden("You are not assigned to the gate at this competition.");

  const db = adminDb();
  const [registrations, attendance, meals] = await Promise.all([
    db.collection(COLLECTIONS.registrations).where("eventId", "==", event.id).where("festId", "==", event.festId).get(),
    mayEnter ? db.collection(COLLECTIONS.attendance).where("eventId", "==", event.id).get() : Promise.resolve(null),
    mayServe && event.mealSlots.length > 0 ? db.collection(COLLECTIONS.foodCollections).where("eventId", "==", event.id).get() : Promise.resolve(null),
  ]);

  const servings = new Map<string, { registrationId: string; servedOn: string; mealType: string; served: number; members: string[] }>();
  for (const doc of meals?.docs ?? []) {
    const m = doc.data();
    const key = `${m.registrationId}:${m.servedOn}:${m.mealType}`;
    const current = servings.get(key);
    servings.set(key, {
      registrationId: String(m.registrationId),
      servedOn: String(m.servedOn),
      mealType: String(m.mealType),
      served: Math.max(current?.served ?? 0, Number(m.serving ?? 0)),
      members: [...(current?.members ?? []), ...(typeof m.memberKey === "string" ? [m.memberKey] : [])],
    });
  }

  return {
    event: { id: event.id, festId: event.festId, title: event.title },
    roster: registrations.docs.map((doc) => projectEntry(asRegistration(doc.id, doc.data()))),
    checkins: (attendance?.docs ?? []).map((doc) => {
      const a = doc.data();
      return {
        registrationId: String(a.registrationId ?? doc.id),
        at: (a.scannedAt?.toDate?.() as Date | undefined)?.getTime() ?? Date.now(),
        members: Array.isArray(a.members) ? (a.members as Array<{ key?: unknown }>).map((m) => String(m.key)) : [],
      };
    }),
    meals: [...servings.values()],
  };
};

/* ───────────── resolving a ticket ───────────── */

type Resolved = { ok: true; registration: RegistrationLike } | { ok: false; outcome: ScanOutcome };

const resolveTicket = async (ticketCode: string, event: GateEvent): Promise<Resolved> => {
  const code = ticketCode.trim().toUpperCase();
  // Looked up within this event's fest: a code from some other fest is simply not found, which is also what to tell the volunteer.
  const found = await adminDb().collection(COLLECTIONS.registrations).where("ticketCode", "==", code).where("festId", "==", event.festId).limit(1).get();
  const doc = found.docs[0];
  if (!doc) return { ok: false, outcome: { result: "not-found" } };
  const registration = asRegistration(doc.id, doc.data());

  if (registration.eventId !== event.id) {
    const other = await adminDb().collection(COLLECTIONS.events).doc(registration.eventId).get();
    return { ok: false, outcome: { result: "wrong-event", expectedEventTitle: String(other.data()?.title ?? "another competition") } };
  }
  const block = admissionBlock({ status: registration.status as never, paymentStatus: registration.paymentStatus as never });
  if (block) return { ok: false, outcome: blockOutcome(block) };
  return { ok: true, registration };
};

/** A queued scan carries the time it was made. Believe it only if it is plausible; otherwise it is now. */
const plausibleTime = (scannedAt: number | undefined): Date => {
  const now = Date.now();
  if (typeof scannedAt === "number" && scannedAt > now - 7 * 24 * 60 * 60 * 1000 && scannedAt < now + 5 * 60 * 1000) return new Date(scannedAt);
  return new Date(now);
};

const actorName = async (caller: Caller): Promise<string> => {
  const profile = (await adminDb().collection(COLLECTIONS.users).doc(caller.uid).get()).data();
  return String(profile?.name ?? profile?.fullName ?? caller.email);
};

const describe = (reg: RegistrationLike, memberCount: number) => ({
  id: reg.id,
  userName: reg.userName,
  ticketCode: reg.ticketCode,
  ...(reg.teamName ? { teamName: reg.teamName } : {}),
  memberCount,
});

/* ───────────── check-in ───────────── */

export const scanEntry = async (
  caller: Caller,
  event: GateEvent,
  input: { ticketCode: string; memberKeys?: string[] | undefined; gate?: string | undefined; scannedAt?: number | undefined },
): Promise<ScanOutcome> => {
  const resolved = await resolveTicket(input.ticketCode, event);
  if (!resolved.ok) return resolved.outcome;
  const { registration } = resolved;

  const db = adminDb();
  const ref = db.collection(COLLECTIONS.attendance).doc(attendanceIdFor(registration.id));
  const roster = rosterOf(registration);
  const wanted = new Set(input.memberKeys ?? roster.map((m) => memberKeyFor(m.email)));
  const at = plausibleTime(input.scannedAt);
  const name = await actorName(caller);

  const view = (present: Map<string, Date>): ScanMember[] =>
    roster.map((member) => {
      const key = memberKeyFor(member.email);
      const markedAt = present.get(key);
      return { key, name: member.name, email: maskEmail(member.email), done: markedAt !== undefined, ...(markedAt ? { at: markedAt } : {}) };
    });

  return db.runTransaction(async (tx): Promise<ScanOutcome> => {
    const existing = await tx.get(ref);
    // Raw fields rather than a validated model: a record written under an older, less strict shape must still be
    // recognised as existing, or a second scan would create a new record and double-count the gate.
    const raw = existing.exists ? (toDates(existing.data()) as Record<string, unknown>) : null;
    const record = raw
      ? {
          members: Array.isArray(raw.members) ? (raw.members as Array<{ key: string; at: Date }>) : [],
          ...(raw.scannedAt instanceof Date ? { scannedAt: raw.scannedAt } : {}),
          ...(typeof raw.scannedByName === "string" ? { scannedByName: raw.scannedByName } : {}),
        }
      : null;

    // A record with no member list predates per-member marking and stands for the whole entry.
    const legacyWhole = record !== null && record.members.length === 0;
    const present = new Map<string, Date>(
      legacyWhole ? roster.map((m) => [memberKeyFor(m.email), record!.scannedAt ?? at] as const) : (record?.members ?? []).map((m) => [m.key, m.at] as const),
    );

    const adding = roster.filter((m) => wanted.has(memberKeyFor(m.email)) && !present.has(memberKeyFor(m.email)));

    if (adding.length === 0) {
      return {
        result: "already-recorded",
        at: record?.scannedAt ?? new Date(),
        ...(record?.scannedByName ? { by: record.scannedByName } : {}),
        registration: describe(registration, roster.length),
        members: view(present),
      };
    }

    const marked = adding.map((m) => ({ key: memberKeyFor(m.email), name: m.name, email: m.email.toLowerCase(), at, by: caller.uid }));

    if (record) {
      // Second wave on the same ticket: extend, never replace.
      tx.update(ref, { members: [...record.members, ...marked], updatedAt: FieldValue.serverTimestamp() });
    } else {
      tx.set(
        ref,
        compact({
          id: ref.id,
          registrationId: registration.id,
          eventId: registration.eventId,
          festId: registration.festId,
          userId: registration.userId,
          userName: registration.userName,
          userEmail: registration.userEmail,
          ticketCode: registration.ticketCode,
          teamName: registration.teamName,
          members: marked,
          memberCount: roster.length,
          method: "qr",
          gate: input.gate,
          scannedAt: FieldValue.serverTimestamp(),
          scannedBy: caller.uid,
          scannedByName: name,
          queuedOffline: input.scannedAt !== undefined,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }),
      );
      // The fest counter counts entries through the gate, not heads - it has always meant "tickets scanned".
      tx.update(db.collection(COLLECTIONS.fests).doc(registration.festId), { "stats.checkIns": FieldValue.increment(1) });
    }

    for (const m of marked) present.set(m.key, at);
    return { result: "ok", registration: describe(registration, roster.length), marked: marked.map((m) => m.key), members: view(present) };
  });
};

/* ───────────── meals ───────────── */

export const serveMeal = async (
  caller: Caller,
  event: GateEvent,
  input: { ticketCode: string; mealType: MealType; servedOn: string; memberKeys?: string[] | undefined; post?: string | undefined; scannedAt?: number | undefined },
): Promise<ScanOutcome> => {
  const resolved = await resolveTicket(input.ticketCode, event);
  if (!resolved.ok) return resolved.outcome;
  const { registration } = resolved;

  const db = adminDb();
  const roster = rosterOf(registration);
  const of = roster.length;
  const wanted = new Set(input.memberKeys ?? roster.map((m) => memberKeyFor(m.email)));
  const name = await actorName(caller);
  const when = input.scannedAt !== undefined ? plausibleTime(input.scannedAt) : undefined;
  const mealRef = (member: string | number) => db.collection(COLLECTIONS.foodCollections).doc(foodCollectionIdFor(registration.id, input.servedOn, input.mealType, member));

  return db.runTransaction(async (tx): Promise<ScanOutcome> => {
    // One document per member per round: a second helping is a write to an id that already exists.
    const taken = new Map<string, { at: Date; by?: string | undefined }>();
    let serving = 0;

    for (const member of roster) {
      const key = memberKeyFor(member.email);
      const snap = await tx.get(mealRef(key));
      if (snap.exists) {
        const raw = toDates(snap.data()) as Record<string, unknown>;
        taken.set(key, { at: raw.collectedAt instanceof Date ? raw.collectedAt : new Date(), by: typeof raw.collectedByName === "string" ? raw.collectedByName : undefined });
      }
    }

    // Records written before per-member meals counted servings instead of naming them. Read those too, so a round
    // already served under the old scheme is not served a second time.
    for (let n = 1; n <= of; n += 1) {
      const snap = await tx.get(mealRef(n));
      if (!snap.exists) break;
      serving = n;
    }
    for (const key of roster.slice(0, serving).map((m) => memberKeyFor(m.email))) if (!taken.has(key)) taken.set(key, { at: new Date() });

    const serve = roster.filter((m) => wanted.has(memberKeyFor(m.email)) && !taken.has(memberKeyFor(m.email)));

    const view = (): ScanMember[] =>
      roster.map((member) => {
        const key = memberKeyFor(member.email);
        const already = taken.get(key);
        return { key, name: member.name, email: maskEmail(member.email), done: already !== undefined, ...(already ? { at: already.at } : {}) };
      });

    if (serve.length === 0) {
      const last = [...taken.values()].at(-1);
      return { result: "already-recorded", at: last?.at ?? new Date(), ...(last?.by ? { by: last.by } : {}), registration: describe(registration, of), members: view() };
    }

    for (const member of serve) {
      const key = memberKeyFor(member.email);
      serving += 1;
      const ref = mealRef(key);
      tx.set(
        ref,
        compact({
          id: ref.id,
          registrationId: registration.id,
          eventId: registration.eventId,
          festId: registration.festId,
          userId: registration.userId,
          userName: registration.userName,
          ticketCode: registration.ticketCode,
          teamName: registration.teamName,
          mealType: input.mealType,
          servedOn: input.servedOn,
          serving,
          memberKey: key,
          memberName: member.name,
          post: input.post,
          collectedAt: when ?? FieldValue.serverTimestamp(),
          collectedBy: caller.uid,
          collectedByName: name,
          queuedOffline: when !== undefined,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }),
      );
      taken.set(key, { at: when ?? new Date() });
    }

    return { result: "ok", registration: describe(registration, of), serving: { n: serving, of }, marked: serve.map((m) => memberKeyFor(m.email)), members: view() };
  });
};
