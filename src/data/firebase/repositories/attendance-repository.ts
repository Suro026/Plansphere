import {
  deleteDoc,
  doc,
  increment,
  getCountFromServer,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  where,
  type QueryConstraint,
} from "firebase/firestore";
import type { Unsubscribe } from "@/core/models/common";
import {
  attendanceIdFor,
  attendanceSchema,
  blockOutcome,
  foodCollectionIdFor,
  foodCollectionSchema,
  memberKeyFor,
  type Attendance,
  type FoodCollection,
  type MealType,
  type ScanMember,
  type ScanOutcome,
} from "@/core/models/attendance";
import { registrationSchema, type Registration } from "@/core/models/registration";
import { eventSchema } from "@/core/models/event";
import { admissionBlock } from "@/core/models/admission";
import type { AttendanceRepository } from "@/core/repositories/attendance-repository";
import { api } from "@/data/api-client";
import { COLLECTIONS, firebaseAuth, firestore } from "../client";
import { guard, stripUndefined, timestampsToDates, toRepositoryError } from "../mapping";
import { col, parseDoc, parseDocs, sortBy, subscribeList } from "../query-helpers";

const attendance = () => col(COLLECTIONS.attendance);
const meals = () => col(COLLECTIONS.foodCollections);
const registrations = () => col(COLLECTIONS.registrations);

/** Resolves a scanned code to its registration, or the reason it cannot be. */
const resolveTicket = async (
  ticketCode: string,
  eventId: string,
): Promise<{ ok: true; registration: Registration } | { ok: false; outcome: ScanOutcome }> => {
  const code = ticketCode.trim().toUpperCase();
  const snapshot = await getDocs(query(registrations(), where("ticketCode", "==", code)));
  const first = snapshot.docs[0];
  const registration = first ? parseDoc(registrationSchema, first, COLLECTIONS.registrations) : null;

  if (!registration) return { ok: false, outcome: { result: "not-found" } };

  if (registration.eventId !== eventId) {
    const other = await getDoc(doc(col(COLLECTIONS.events), registration.eventId));
    const parsed = other.exists() ? parseDoc(eventSchema, other, COLLECTIONS.events) : null;
    return {
      ok: false,
      outcome: { result: "wrong-event", expectedEventTitle: parsed?.title ?? registration.eventTitle },
    };
  }

  // One rule for every gate: confirmed (or draft team), and paid if it had to be.
  const block = admissionBlock(registration);
  if (block) return { ok: false, outcome: blockOutcome(block) };

  return { ok: true, registration };
};

export class FirestoreAttendanceRepository implements AttendanceRepository {
  /**
   * Check-in.
   *
   * The attendance document id *is* the registration id, and the write is a
   * transaction that creates only if absent. Two volunteers scanning the same
   * ticket in the same second therefore cannot both succeed: the second sees
   * the first's record and reports "already checked in" with its timestamp.
   * Firestore rules back this up by denying updates to attendance documents.
   *
   * Manual (non-QR) entry is an admin action and goes through the server so
   * it lands in the audit log; volunteers cannot mark it from here.
   */
  recordScan(input: { ticketCode: string; eventId: string; scannedBy: string; method?: "qr" | "manual"; gate?: string; scannedAt?: Date; memberKeys?: string[] }): Promise<ScanOutcome> {
    return guard("Recording check-in", async () => {
      if (input.method === "manual") {
        return api<ScanOutcome>("/api/admin/attendance/manual", {
          method: "POST",
          body: { ticketCode: input.ticketCode, eventId: input.eventId, gate: input.gate },
        });
      }

      const resolved = await resolveTicket(input.ticketCode, input.eventId);
      if (!resolved.ok) return resolved.outcome;

      const { registration } = resolved;
      const ref = doc(attendance(), attendanceIdFor(registration.id));

      // Who this scan is for. No list means the whole entry — a solo ticket,
      // or a team that walked in together.
      const roster = registration.members.length
        ? registration.members
        : [{ name: registration.userName, email: registration.userEmail }];
      const wanted = new Set(input.memberKeys ?? roster.map((m) => memberKeyFor(m.email)));
      const at = input.scannedAt ?? new Date();

      const describe = () => ({
        id: registration.id,
        userName: registration.userName,
        ticketCode: registration.ticketCode,
        ...(registration.teamName ? { teamName: registration.teamName } : {}),
        memberCount: roster.length,
      });

      const view = (present: Map<string, Date>): ScanMember[] =>
        roster.map((member) => {
          const key = memberKeyFor(member.email);
          const markedAt = present.get(key);
          return { key, name: member.name, email: member.email, done: markedAt !== undefined, ...(markedAt ? { at: markedAt } : {}) };
        });

      try {
        return await runTransaction(firestore(), async (tx) => {
          const existing = await tx.get(ref);
          // Read the raw fields rather than the full validated model: this is
          // the one place a document written under an older, less strict
          // shape must still be recognised as existing. A schema mismatch
          // silently returning "not found" here would make a second scan
          // create a brand new record and double-count the gate.
          const raw = existing.exists() ? (timestampsToDates(existing.data()) as Record<string, unknown>) : null;
          const record: { members: { key: string; at: Date }[]; scannedAt?: Date; scannedByName?: string } | null = raw
            ? {
                members: Array.isArray(raw.members) ? (raw.members as { key: string; at: Date }[]) : [],
                ...(raw.scannedAt instanceof Date ? { scannedAt: raw.scannedAt } : {}),
                ...(typeof raw.scannedByName === "string" ? { scannedByName: raw.scannedByName } : {}),
              }
            : null;

          // A record with no member list predates per-member marking and
          // stands for the whole entry.
          const legacyWhole = record !== null && record.members.length === 0;
          const present = new Map<string, Date>(
            legacyWhole
              ? roster.map((m) => [memberKeyFor(m.email), record!.scannedAt ?? at] as const)
              : (record?.members ?? []).map((m) => [m.key, m.at] as const),
          );

          const adding = roster.filter((m) => wanted.has(memberKeyFor(m.email)) && !present.has(memberKeyFor(m.email)));

          if (adding.length === 0) {
            return {
              result: "already-recorded",
              at: record?.scannedAt ?? new Date(),
              ...(record?.scannedByName ? { by: record.scannedByName } : {}),
              registration: describe(),
              members: view(present),
            } satisfies ScanOutcome;
          }

          const marked = adding.map((m) => ({
            key: memberKeyFor(m.email),
            name: m.name,
            email: m.email.toLowerCase(),
            at,
            by: input.scannedBy,
          }));

          if (record) {
            // Second wave on the same ticket: extend, never replace. The
            // rules refuse a write that shortens this array.
            tx.update(ref, {
              members: [...record.members, ...marked],
              updatedAt: serverTimestamp(),
            });
          } else {
            tx.set(
              ref,
              stripUndefined({
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
                method: input.method === "manual" ? "manual" : "qr",
                gate: input.gate,
                scannedAt: serverTimestamp(),
                scannedBy: input.scannedBy,
                scannedByName: firebaseAuth().currentUser?.displayName ?? undefined,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              }),
            );

            // The fest counter counts entries through the gate, not heads —
            // it has always meant "tickets scanned", so it moves once.
            tx.update(doc(col(COLLECTIONS.fests), registration.festId), { "stats.checkIns": increment(1) });
          }

          for (const m of marked) present.set(m.key, at);

          return {
            result: "ok",
            registration: describe(),
            marked: marked.map((m) => m.key),
            members: view(present),
          } satisfies ScanOutcome;
        });
      } catch (error) {
        throw toRepositoryError(error, "Recording check-in");
      }
    });
  }

  getByRegistration(registrationId: string): Promise<Attendance | null> {
    return guard("Loading check-in", async () => {
      const snapshot = await getDoc(doc(attendance(), attendanceIdFor(registrationId)));
      return snapshot.exists() ? parseDoc(attendanceSchema, snapshot, COLLECTIONS.attendance) : null;
    });
  }

  listByEvent(eventId: string): Promise<Attendance[]> {
    return guard("Loading check-ins", async () => {
      const snapshot = await getDocs(query(attendance(), where("eventId", "==", eventId)));
      return sortBy(parseDocs(attendanceSchema, snapshot.docs, COLLECTIONS.attendance), [(a) => a.scannedAt, "desc"]);
    });
  }

  attendedRegistrationIds(eventId: string): Promise<Set<string>> {
    return guard("Loading check-ins", async () => {
      const snapshot = await getDocs(query(attendance(), where("eventId", "==", eventId)));
      return new Set(snapshot.docs.map((d) => d.id));
    });
  }

  subscribeByEvent(eventId: string, onChange: (records: Attendance[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(
      query(attendance(), where("eventId", "==", eventId)),
      attendanceSchema,
      COLLECTIONS.attendance,
      (items) => onChange(sortBy(items, [(a) => a.scannedAt, "desc"])),
      onError,
    );
  }

  subscribeByFest(festId: string, onChange: (records: Attendance[]) => void, onError: (error: unknown) => void, limit = 50): Unsubscribe {
    return subscribeList(
      query(attendance(), where("festId", "==", festId)),
      attendanceSchema,
      COLLECTIONS.attendance,
      (items) => onChange(sortBy(items, [(a) => a.scannedAt, "desc"]).slice(0, limit)),
      onError,
    );
  }

  countByEvent(eventId: string): Promise<number> {
    return guard("Counting check-ins", async () => {
      const snapshot = await getCountFromServer(query(attendance(), where("eventId", "==", eventId)));
      return snapshot.data().count;
    });
  }

  countByFest(festId: string): Promise<number> {
    return guard("Counting check-ins", async () => {
      const snapshot = await getCountFromServer(query(attendance(), where("festId", "==", festId)));
      return snapshot.data().count;
    });
  }

  remove(registrationId: string): Promise<void> {
    return guard("Removing check-in", async () => {
      await deleteDoc(doc(attendance(), attendanceIdFor(registrationId)));
    });
  }

  /**
   * Meal handout. One document per serving, keyed entry + day + slot + n,
   * so a team of three collects exactly three lunches and a fourth scan is
   * refused. The transaction reads servings 1..memberCount and creates the
   * first gap; two counters serving the same team at once cannot both take
   * serving 3.
   */
  recordMeal(input: { ticketCode: string; eventId: string; mealType: MealType; servedOn: string; collectedBy: string; post?: string; scannedAt?: Date; memberKeys?: string[] }): Promise<ScanOutcome> {
    return guard("Recording meal", async () => {
      const resolved = await resolveTicket(input.ticketCode, input.eventId);
      if (!resolved.ok) return resolved.outcome;

      const { registration } = resolved;
      const roster = registration.members.length
        ? registration.members
        : [{ name: registration.userName, email: registration.userEmail }];
      const of = roster.length;
      const wanted = new Set(input.memberKeys ?? roster.map((m) => memberKeyFor(m.email)));

      const describe = () => ({
        id: registration.id,
        userName: registration.userName,
        ticketCode: registration.ticketCode,
        ...(registration.teamName ? { teamName: registration.teamName } : {}),
        memberCount: of,
      });

      try {
        return await runTransaction(firestore(), async (tx) => {
          // One document per member per round: a second helping is a write
          // to an id that already exists, which is a conflict rather than a
          // count that two counters could race past.
          const taken = new Map<string, { at: Date; by?: string | undefined }>();
          let serving = 0;

          for (const member of roster) {
            const key = memberKeyFor(member.email);
            const snap = await tx.get(doc(meals(), foodCollectionIdFor(registration.id, input.servedOn, input.mealType, key)));
            if (snap.exists()) {
              // Raw fields, not the validated model — see the matching note
              // in recordScan. A schema mismatch here must not read back as
              // "nobody has collected this yet".
              const raw = timestampsToDates(snap.data()) as Record<string, unknown>;
              taken.set(key, {
                at: raw.collectedAt instanceof Date ? raw.collectedAt : new Date(),
                by: typeof raw.collectedByName === "string" ? raw.collectedByName : undefined,
              });
            }
          }

          // Records written before per-member meals counted servings instead
          // of naming them. Read those too, so a round already served under
          // the old scheme is not served a second time.
          for (let n = 1; n <= of; n += 1) {
            const snap = await tx.get(doc(meals(), foodCollectionIdFor(registration.id, input.servedOn, input.mealType, n)));
            if (!snap.exists()) break;
            serving = n;
          }

          const legacyCovered = roster.slice(0, serving).map((m) => memberKeyFor(m.email));
          for (const key of legacyCovered) if (!taken.has(key)) taken.set(key, { at: new Date() });

          const serve = roster.filter((m) => wanted.has(memberKeyFor(m.email)) && !taken.has(memberKeyFor(m.email)));

          const view = (): ScanMember[] =>
            roster.map((member) => {
              const key = memberKeyFor(member.email);
              const already = taken.get(key);
              return { key, name: member.name, email: member.email, done: already !== undefined, ...(already ? { at: already.at } : {}) };
            });

          if (serve.length === 0) {
            const last = [...taken.values()].at(-1);
            return {
              result: "already-recorded",
              at: last?.at ?? new Date(),
              ...(last?.by ? { by: last.by } : {}),
              registration: describe(),
              members: view(),
            } satisfies ScanOutcome;
          }

          for (const member of serve) {
            const key = memberKeyFor(member.email);
            serving += 1;
            const ref = doc(meals(), foodCollectionIdFor(registration.id, input.servedOn, input.mealType, key));
            tx.set(
              ref,
              stripUndefined({
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
                collectedAt: input.scannedAt ?? serverTimestamp(),
                collectedBy: input.collectedBy,
                collectedByName: firebaseAuth().currentUser?.displayName ?? undefined,
                queuedOffline: Boolean(input.scannedAt),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              }),
            );
            taken.set(key, { at: input.scannedAt ?? new Date() });
          }

          return {
            result: "ok",
            registration: describe(),
            serving: { n: serving, of },
            marked: serve.map((m) => memberKeyFor(m.email)),
            members: view(),
          } satisfies ScanOutcome;
        });
      } catch (error) {
        throw toRepositoryError(error, "Recording meal");
      }
    });
  }

  listMealsByEvent(eventId: string, servedOn?: string): Promise<FoodCollection[]> {
    return guard("Loading meals", async () => {
      const constraints: QueryConstraint[] = [where("eventId", "==", eventId)];
      if (servedOn) constraints.push(where("servedOn", "==", servedOn));
      const snapshot = await getDocs(query(meals(), ...constraints));
      return sortBy(parseDocs(foodCollectionSchema, snapshot.docs, COLLECTIONS.foodCollections), [(m) => m.collectedAt, "desc"]);
    });
  }

  listMealsForUser(userId: string): Promise<FoodCollection[]> {
    return guard("Loading meals", async () => {
      const snapshot = await getDocs(query(meals(), where("userId", "==", userId)));
      return parseDocs(foodCollectionSchema, snapshot.docs, COLLECTIONS.foodCollections);
    });
  }

  countMeals(eventId: string, servedOn?: string, mealType?: MealType): Promise<number> {
    return guard("Counting meals", async () => {
      const constraints: QueryConstraint[] = [where("eventId", "==", eventId)];
      if (servedOn) constraints.push(where("servedOn", "==", servedOn));
      if (mealType) constraints.push(where("mealType", "==", mealType));
      const snapshot = await getCountFromServer(query(meals(), ...constraints));
      return snapshot.data().count;
    });
  }

  countMealsByFest(festId: string): Promise<number> {
    return guard("Counting meals", async () => {
      const snapshot = await getCountFromServer(query(meals(), where("festId", "==", festId)));
      return snapshot.data().count;
    });
  }
}
