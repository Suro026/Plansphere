import { z } from "zod";
import { holdsSeat, joinCodeSchema, registrationFor, teamIsComplete, type RegistrationStatus, type RegistrationWire } from "@/core/models/registration";
import { ApiError, authenticate, handler, ok, readBody } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, FieldValue, Timestamp, adminDb } from "@/server/firebase-admin";
import { compact, docToJson } from "@/server/serialize";
import { notify } from "@/server/notify";

type MemberDoc = Record<string, unknown> & { email: string; name: string; isLeader?: boolean; inviteStatus?: string };

/**
 * POST /api/registrations/join — join a team with the code the leader gave you.
 *
 * The other half of team assembly. Invitation by email needs the leader to
 * know an address; a code works across a room, in a WhatsApp group, on a
 * whiteboard. Joining this way lands as `accepted` immediately — typing the
 * code *is* the acceptance, so there is nothing further to confirm.
 *
 * Everything the invitation path checks is checked here too, inside the same
 * transaction: the team must have room, the event must have a seat, and
 * nobody may be on two teams for one event.
 */
const bodySchema = z.object({
  code: joinCodeSchema,
  /** Optional: the event, when the student has it. Narrows a code collision. */
  eventId: z.string().min(1).max(128).optional(),
});

export const POST = handler(async (request) => {
  const caller = await authenticate(request);

  if (!caller.emailVerified) {
    throw ApiError.forbidden("Verify your email before joining a team — your ticket and certificate are sent to it.");
  }

  const { code, eventId } = await readBody(request, bodySchema);
  const db = adminDb();

  // Resolve the code outside the transaction: a query cannot be re-run inside
  // one against a collection, and the document is re-read under the lock
  // below before anything is written.
  let query = db.collection(COLLECTIONS.registrations).where("joinCode", "==", code);
  if (eventId) query = query.where("eventId", "==", eventId);
  const found = await query.limit(5).get();

  const candidate = found.docs.find((doc) => doc.data().status !== "cancelled");
  if (!candidate) throw ApiError.notFound("No team has that code. Check it with your team leader.");

  const profile = (await db.collection(COLLECTIONS.users).doc(caller.uid).get()).data() ?? {};
  const name = String(profile.name ?? profile.fullName ?? "").trim();
  if (!name) throw ApiError.unprocessable("Add your name to your profile before joining a team.");

  const regRef = candidate.ref;

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(regRef);
    if (!snap.exists) throw ApiError.notFound("That team no longer exists.");
    const reg = snap.data()!;

    if (reg.status === "cancelled") throw ApiError.unprocessable("That entry was cancelled.");
    if (reg.type !== "team") throw ApiError.unprocessable("That code belongs to a solo entry.");
    // An entry still waiting for its payment is not a team yet; joining it would let a roster change confirm it unpaid.
    if (reg.status === "pending_payment") throw ApiError.conflict("This team is waiting for its leader to complete the payment. Try again once it is confirmed.");

    const members = ((reg.members ?? []) as MemberDoc[]).map((m) => ({ ...m, email: String(m.email).toLowerCase() }));
    const status = (reg.status ?? "confirmed") as RegistrationStatus;

    const eventSnap = await tx.get(db.collection(COLLECTIONS.events).doc(String(reg.eventId)));
    if (!eventSnap.exists) throw ApiError.notFound("That event no longer exists.");
    const event = eventSnap.data()!;
    const teamSize = (event.teamSize ?? { min: 1, max: 1 }) as { min: number; max: number };

    const attendanceSnap = await tx.get(db.collection(COLLECTIONS.attendance).doc(snap.id));
    if (attendanceSnap.exists || event.status === "ongoing" || event.status === "completed" || event.status === "cancelled") {
      throw ApiError.unprocessable("This team is closed — the event has started or the pass has been scanned.");
    }

    const existing = members.find((m) => m.email === caller.email);
    if (existing) {
      if (existing.inviteStatus === "accepted") return { kind: "already" as const, reg, moved: undefined };
      // Invited by email *and* given the code: the code settles it.
      const next = members.map((m) =>
        m.email === caller.email ? { ...m, userId: caller.uid, inviteStatus: "accepted", respondedAt: Timestamp.now() } : m,
      );
      const moved = applyStatus(tx, regRef, next, status, teamSize, attendanceSnap.exists);
      return { kind: "accepted" as const, reg, moved };
    }

    if (members.length >= teamSize.max) {
      throw ApiError.unprocessable(`${reg.teamName ?? "That team"} is full — it allows at most ${teamSize.max} members.`);
    }

    // Nobody may hold two entries for one event, whichever door they came in by.
    const clash = await tx.get(
      db
        .collection(COLLECTIONS.registrations)
        .where("eventId", "==", reg.eventId)
        .where("memberEmails", "array-contains", caller.email),
    );
    if (clash.docs.some((doc) => doc.id !== snap.id && doc.data().status !== "cancelled")) {
      throw ApiError.conflict("You already hold an entry for this event.");
    }

    // A seated team needs a free seat for the new member; a waitlisted one
    // takes nothing yet.
    const capacity = Number(event.capacity ?? 0);
    const registered = Number(event.registeredCount ?? 0);
    if (holdsSeat(status) && capacity > 0 && registered + 1 > capacity) {
      throw ApiError.unprocessable("This event is full — there is no seat for another member.");
    }

    const member: MemberDoc = compact({
      name,
      email: caller.email,
      phone: profile.phone,
      studentId: profile.studentId,
      college: profile.college,
      userId: caller.uid,
      isLeader: false,
      inviteStatus: "accepted",
      respondedAt: Timestamp.now(),
    });

    const next = [...members, member];
    const moved = applyStatus(tx, regRef, next, status, teamSize, attendanceSnap.exists);

    tx.update(regRef, { seats: FieldValue.increment(1) });
    if (holdsSeat(status)) {
      tx.update(eventSnap.ref, { registeredCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
      tx.update(db.collection(COLLECTIONS.fests).doc(String(reg.festId)), { "stats.registrations": FieldValue.increment(1) });
    }

    return { kind: "joined" as const, reg, moved };
  });

  const saved = await regRef.get();
  // The caller is a teammate now, not the leader: they get the shared ticket, not everyone's contact details.
  const registration = registrationFor(docToJson<RegistrationWire>(saved)!, caller);
  const data = saved.data() ?? {};
  const teamName = String(data.teamName ?? "the team");
  const eventTitle = String(data.eventTitle ?? "");
  const leaderUid = String(data.userId ?? "");

  if (outcome.kind !== "already" && leaderUid) {
    await notify({
      userId: leaderUid,
      type: "team_update",
      title: `${name} joined ${teamName}`,
      body: eventTitle,
      link: "/teams",
      festId: String(data.festId ?? ""),
      eventId: String(data.eventId ?? ""),
    });

    if (outcome.moved === "confirmed") {
      await notify({
        userId: leaderUid,
        type: "team_update",
        title: `${teamName} is confirmed`,
        body: `${eventTitle} · your pass is ready`,
        link: "/my-pass",
        festId: String(data.festId ?? ""),
        eventId: String(data.eventId ?? ""),
      });
    }
  }

  return ok({ registration, joined: outcome.kind !== "already" });
}, { rateLimit: RATE_LIMITS.authenticated.registration });

/**
 * Writes the roster and moves the entry between draft and confirmed as the
 * minimum is met or lost. Shared with the invitation path in spirit; kept
 * here rather than exported because the transaction handle cannot travel.
 */
const applyStatus = (
  tx: FirebaseFirestore.Transaction,
  ref: FirebaseFirestore.DocumentReference,
  members: MemberDoc[],
  status: RegistrationStatus,
  teamSize: { min: number },
  scanned: boolean,
): RegistrationStatus | undefined => {
  const moved =
    holdsSeat(status) && !scanned
      ? teamIsComplete(members, teamSize)
        ? status === "confirmed"
          ? undefined
          : ("confirmed" as const)
        : status === "draft"
          ? undefined
          : ("draft" as const)
      : undefined;

  tx.update(ref, {
    members: members.map((m) => compact(m)),
    memberEmails: members.map((m) => m.email),
    ...(moved ? { status: moved } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return moved;
};
