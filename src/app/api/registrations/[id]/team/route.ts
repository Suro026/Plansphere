import { holdsSeat, teamActionSchema, teamIsComplete, type RegistrationStatus } from "@/core/models/registration";
import { ApiError, authenticate, handler, ok, readBody } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, FieldValue, Timestamp, adminDb } from "@/server/firebase-admin";
import { compact, docToJson } from "@/server/serialize";
import { emailService } from "@/server/email";
import { teamInviteEmail, teamUpdateEmail } from "@/server/email/templates";
import { notify } from "@/server/notify";

type MemberDoc = Record<string, unknown> & { email: string; name: string; isLeader?: boolean; userId?: string; inviteStatus?: string };

/**
 * POST /api/registrations/[id]/team — manage a team after it exists.
 *
 * Leader: invite, remove, rename. Named teammate: accept, decline.
 *
 * Seats and members move together inside one transaction against the event:
 * an invite takes a seat only if one is free (or the entry is waitlisted, in
 * which case it takes nothing yet), and removing or declining gives it back
 * at once. The team is frozen once the event has started or the pass has
 * been scanned — after that the roster is a record, not a plan.
 */
export const POST = handler(async (request, context) => {
  const caller = await authenticate(request);
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing registration id.");

  const input = await readBody(request, teamActionSchema);
  const db = adminDb();
  const regRef = db.collection(COLLECTIONS.registrations).doc(id);

  // Resolve an invitee's account before the transaction (a stale read here
  // is harmless: link-account backfills the uid later if it is missing).
  let inviteeUid: string | undefined;
  if (input.action === "invite") {
    const found = await db.collection(COLLECTIONS.users).where("email", "==", input.member.email.toLowerCase()).limit(1).get();
    inviteeUid = found.docs[0]?.id;
  }

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(regRef);
    if (!snap.exists) throw ApiError.notFound("That registration no longer exists.");
    const reg = snap.data()!;

    if (reg.status === "cancelled") throw ApiError.unprocessable("This entry was cancelled.");
    if (reg.type !== "team") throw ApiError.unprocessable("This is a solo entry; there is no team to manage.");
    // The roster is frozen while the seat is awaiting payment: a roster change must never be able to confirm an unpaid entry.
    if (reg.status === "pending_payment" && input.action !== "rename") {
      throw ApiError.conflict("Complete the payment first — the team can be changed once the entry is confirmed.");
    }

    const members = ((reg.members ?? []) as MemberDoc[]).map((m) => ({ ...m, email: String(m.email).toLowerCase() }));
    const isLeader = reg.userId === caller.uid;
    const me = members.find((m) => m.email === caller.email);

    const [eventSnap, attendanceSnap] = await Promise.all([
      tx.get(db.collection(COLLECTIONS.events).doc(String(reg.eventId))),
      tx.get(db.collection(COLLECTIONS.attendance).doc(snap.id)),
    ]);
    const event = eventSnap.data() ?? {};
    const teamSize = (event.teamSize ?? { min: 1, max: 1 }) as { min: number; max: number };

    const frozen =
      attendanceSnap.exists || event.status === "ongoing" || event.status === "completed" || event.status === "cancelled";
    const now = Timestamp.now();
    const status = (reg.status ?? "confirmed") as RegistrationStatus;
    // A draft team occupies its seats while it assembles, so both states move
    // the counters; only a waitlisted entry takes nothing yet.
    const seated = holdsSeat(status);
    const confirmed = status === "confirmed";
    const eventRef = eventSnap.ref;
    const festRef = db.collection(COLLECTIONS.fests).doc(String(reg.festId));

    const adjustSeats = (delta: number) => {
      tx.update(regRef, { seats: FieldValue.increment(delta) });
      if (seated) {
        tx.update(eventRef, { registeredCount: FieldValue.increment(delta), updatedAt: FieldValue.serverTimestamp() });
        tx.update(festRef, { "stats.registrations": FieldValue.increment(delta) });
      }
    };

    /**
     * The team's state follows its roster.
     *
     * Enough people have said yes → confirmed; not any more → back to draft,
     * which is what stops an incomplete team holding a ticket it cannot use.
     * A waitlisted or cancelled entry is left alone: its state is about a
     * seat, not about the roster. So is a team that has already been scanned
     * in — by then the roster is a record, not a plan.
     */
    const nextStatus = (next: MemberDoc[]): RegistrationStatus | undefined => {
      if (!seated || attendanceSnap.exists) return undefined;
      const complete = teamIsComplete(next, teamSize);
      const wanted: RegistrationStatus = complete ? "confirmed" : "draft";
      return wanted === status ? undefined : wanted;
    };

    const write = (next: MemberDoc[], extra: Record<string, unknown> = {}) => {
      const moved = nextStatus(next);
      tx.update(regRef, {
        members: next.map((m) => compact(m)),
        memberEmails: next.map((m) => m.email),
        ...(moved ? { status: moved } : {}),
        updatedAt: FieldValue.serverTimestamp(),
        ...extra,
      });
      return moved;
    };

    switch (input.action) {
      case "rename": {
        if (!isLeader) throw ApiError.forbidden("Only the team leader can rename the team.");
        tx.update(regRef, { teamName: input.teamName.trim(), updatedAt: FieldValue.serverTimestamp() });
        return { kind: "rename" as const };
      }

      case "invite": {
        if (!isLeader) throw ApiError.forbidden("Only the team leader can add members.");
        if (frozen) throw ApiError.unprocessable("The team can't change once the event has started or the pass has been scanned.");
        const email = input.member.email.toLowerCase();
        if (members.some((m) => m.email === email)) throw ApiError.conflict(`${email} is already on this team.`);
        if (members.length >= teamSize.max) throw ApiError.unprocessable(`This event allows at most ${teamSize.max} members.`);

        // The invitee may not already be on another team for this event.
        const clash = await tx.get(
          db.collection(COLLECTIONS.registrations).where("eventId", "==", reg.eventId).where("memberEmails", "array-contains", email),
        );
        if (clash.docs.some((d) => d.id !== snap.id && d.data().status !== "cancelled")) {
          throw ApiError.conflict(`${email} is already on another team for this event.`);
        }

        // A confirmed team needs a free seat; a waitlisted one takes nothing yet.
        const capacity = Number(event.capacity ?? 0);
        const registered = Number(event.registeredCount ?? 0);
        if (confirmed && capacity > 0 && registered + 1 > capacity) {
          throw ApiError.unprocessable("This event is full — there is no seat for another member.");
        }

        const member: MemberDoc = compact({
          name: input.member.name.trim(),
          email,
          phone: input.member.phone,
          studentId: input.member.studentId,
          college: input.member.college,
          userId: inviteeUid,
          isLeader: false,
          inviteStatus: "pending",
          invitedAt: now,
        });
        const moved = write([...members, member]);
        adjustSeats(1);
        return { kind: "invite" as const, member, reg, event, moved };
      }

      case "remove": {
        if (!isLeader) throw ApiError.forbidden("Only the team leader can remove members.");
        if (frozen) throw ApiError.unprocessable("The team can't change once the event has started or the pass has been scanned.");
        const email = input.email.toLowerCase();
        const target = members.find((m) => m.email === email);
        if (!target) throw ApiError.notFound("That person isn't on this team.");
        if (target.isLeader) throw ApiError.unprocessable("The leader can't be removed — cancel the entry instead.");
        const moved = write(members.filter((m) => m.email !== email));
        adjustSeats(-1);
        return { kind: "remove" as const, target, reg, moved };
      }

      case "accept": {
        if (!me || me.isLeader) throw ApiError.forbidden("You're not invited to this team.");
        if (me.inviteStatus === "accepted") return { kind: "noop" as const };
        const moved = write(
          members.map((m) => (m.email === caller.email ? { ...m, userId: caller.uid, inviteStatus: "accepted", respondedAt: now } : m)),
        );
        return { kind: "accept" as const, me, reg, moved };
      }

      case "decline": {
        if (!me || me.isLeader) throw ApiError.forbidden("You're not invited to this team.");
        if (frozen) throw ApiError.unprocessable("The event has started, so the entry can't change now.");
        const moved = write(members.filter((m) => m.email !== caller.email));
        adjustSeats(-1);
        return { kind: "decline" as const, me, reg, moved };
      }
    }
  });

  const saved = await regRef.get();
  const registration = docToJson(saved)!;

  // Side effects after the write; none may undo it.
  const festId = String(saved.data()?.festId ?? "");
  const eventId = String(saved.data()?.eventId ?? "");
  const teamName = String(saved.data()?.teamName ?? "your team");
  const eventTitle = String(saved.data()?.eventTitle ?? "");
  const leaderName = String(saved.data()?.userName ?? "Your teammate");
  const leaderEmail = String(saved.data()?.userEmail ?? "");
  const leaderUid = String(saved.data()?.userId ?? "");
  const meta = (userId?: string) => ({ ...(userId ? { userId } : {}), festId, eventId, subjectType: "registration", subjectId: saved.id });

  const tell = (userId: string | undefined, type: "team_invite" | "team_update", title: string, body: string) =>
    userId ? notify({ userId, type, title, body, link: "/teams", festId, eventId }) : Promise.resolve(null);

  const mailer = emailService();

  if (outcome.kind === "invite") {
    const festName = await festRefName(db, festId);
    await tell(outcome.member.userId, "team_invite", `${leaderName} added you to ${teamName}`, eventTitle);
    await mailer.send(
      teamInviteEmail({
        to: outcome.member.email,
        recipientName: outcome.member.name,
        leaderName,
        teamName,
        eventTitle,
        festName,
        date: String(outcome.event.date ?? ""),
        meta: meta(outcome.member.userId),
      }),
    );
  } else if (outcome.kind === "remove") {
    await tell(outcome.target.userId, "team_update", `You were removed from ${teamName}`, eventTitle);
    await mailer.send(teamUpdateEmail({ to: outcome.target.email, recipientName: outcome.target.name, teamName, eventTitle, change: "removed", meta: meta(outcome.target.userId) }));
  } else if (outcome.kind === "accept") {
    await tell(leaderUid, "team_update", `${outcome.me.name} joined ${teamName}`, eventTitle);
    if (outcome.moved === "confirmed") {
      await tell(leaderUid, "team_update", `${teamName} is confirmed`, `${eventTitle} · your pass is ready`);
    }
    if (leaderEmail) await mailer.send(teamUpdateEmail({ to: leaderEmail, recipientName: leaderName, teamName, eventTitle, change: "accepted", memberName: outcome.me.name, meta: meta(leaderUid) }));
  } else if (outcome.kind === "decline") {
    await tell(leaderUid, "team_update", `${outcome.me.name} declined to join ${teamName}`, `${eventTitle} · a seat was released`);
    if (outcome.moved === "draft") {
      await tell(leaderUid, "team_update", `${teamName} is below its minimum`, `${eventTitle} · add someone to confirm the entry`);
    }
    if (leaderEmail) await mailer.send(teamUpdateEmail({ to: leaderEmail, recipientName: leaderName, teamName, eventTitle, change: "declined", memberName: outcome.me.name, meta: meta(leaderUid) }));
  }

  return ok({ registration });
}, { rateLimit: RATE_LIMITS.authenticated.registration });

const festRefName = async (db: FirebaseFirestore.Firestore, festId: string): Promise<string> =>
  String((await db.collection(COLLECTIONS.fests).doc(festId).get()).data()?.name ?? "");
