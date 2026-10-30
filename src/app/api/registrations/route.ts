import {
  createRegistrationSchema,
  generateJoinCode,
  generateTicketCode,
  teamIsComplete,
  validateRegistration,
} from "@/core/models/registration";
import { autofillFor, profileMemoryFrom, profileUpdatesFrom } from "@/core/services/autofill";
import { visibleFields } from "@/core/models/registration-fields";
import { isRegistrationOpen } from "@/core/models/event";
import { cleanAnswers, mergeRegistrationFields, registrationFieldsSchema, validateAnswers } from "@/core/models/registration-fields";
import { ApiError, authenticate, handler, ok, readBody } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, FieldValue, Timestamp, adminDb } from "@/server/firebase-admin";
import { compact, docToJson, randomBytes } from "@/server/serialize";
import { eventRequiresPayment } from "@/core/models/payment";
import { assertOrderingAllowed, type StoredAccount } from "@/server/payments/account";
import { expirePendingHolds, writeHold } from "@/server/payments/lifecycle";
import { announceRegistration } from "@/server/registrations/announce";

/**
 * POST /api/registrations — register for an event.
 *
 * Everything that decides whether a seat is granted happens inside one
 * Firestore transaction: the event is re-read, the window and capacity are
 * re-checked, the duplicate check runs, and the registration and the seat
 * counter are written together. Two students submitting for the last seat in
 * the same instant therefore get one success and one honest "full", never two
 * tickets. A team consumes seats equal to its member count.
 */
export const POST = handler(async (request) => {
  const caller = await authenticate(request);

  if (!caller.emailVerified) {
    throw ApiError.forbidden("Verify your email before registering — your ticket and certificate are sent to it.");
  }

  const input = await readBody(request, createRegistrationSchema);
  const db = adminDb();

  const eventRef = db.collection(COLLECTIONS.events).doc(input.eventId);
  const userSnap = await db.collection(COLLECTIONS.users).doc(caller.uid).get();
  const profile = userSnap.data() ?? {};

  // The leader is always the caller. Whatever the form sent for row 0 is
  // replaced with the verified identity, so nobody registers "as" someone else.
  const leaderName = String(profile.name ?? profile.fullName ?? input.members[0]?.name ?? "").trim();
  if (!leaderName) throw ApiError.unprocessable("Add your name to your profile before registering.");

  // Resolve teammates who already have accounts, so their certificates can
  // reach them. Done before the transaction: it is a read that can be stale
  // without consequence.
  const teammateEmails = input.members.slice(1).map((m) => m.email.toLowerCase());
  const userIdByEmail = new Map<string, string>();

  for (let i = 0; i < teammateEmails.length; i += 30) {
    const chunk = teammateEmails.slice(i, i + 30);
    if (!chunk.length) break;
    const found = await db.collection(COLLECTIONS.users).where("email", "in", chunk).get();
    for (const d of found.docs) userIdByEmail.set(String(d.data().email), d.id);
  }

  // A paid event that looks full may only be full of unpaid holds whose time is
  // up. Release those first so capacity heals even before the scheduled sweep has
  // run (best effort: a failure here must never block a registration).
  const preview = (await eventRef.get()).data();
  if (preview && eventRequiresPayment(preview) && Number(preview.capacity ?? 0) > 0 && Number(preview.registeredCount ?? 0) + input.members.length > Number(preview.capacity)) {
    await expirePendingHolds({ eventId: input.eventId, limit: 25 }).catch(() => undefined);
  }

  const result = await db.runTransaction(async (tx) => {
    const eventSnap = await tx.get(eventRef);
    if (!eventSnap.exists) throw ApiError.notFound("That event no longer exists.");

    const event = eventSnap.data()!;
    const teamSize = event.teamSize ?? { min: 1, max: 1 };

    // A short team is allowed in: it lands as a draft and confirms when
    // enough people accept or join with the code.
    const check = validateRegistration(input, { eventType: event.eventType ?? "solo", teamSize }, { allowIncomplete: true });
    if (!check.ok) throw ApiError.unprocessable(check.message);

    // The fest is the outer gate: its own switch closes every event at once,
    // and its field configuration is what the answers are checked against.
    // Read inside the transaction, before any write, so a fest closed a
    // second ago cannot let one more entry through.
    const festSnap = await tx.get(db.collection(COLLECTIONS.fests).doc(String(event.festId)));
    const fest = festSnap.data() ?? {};

    if ((fest.registrationState ?? "open") !== "open") {
      throw ApiError.unprocessable(
        fest.registrationState === "upcoming"
          ? "Registration for this fest has not opened yet."
          : "Registration for this fest is closed.",
      );
    }

    const parsedFestFields = registrationFieldsSchema.safeParse(fest.registrationFields);
    const parsedEventFields = registrationFieldsSchema.safeParse(event.registrationFields);
    const fields = mergeRegistrationFields(
      parsedFestFields.success ? parsedFestFields.data : undefined,
      parsedEventFields.success ? parsedEventFields.data : undefined,
    );

    // Auto-fill runs here too, not only in the form. A student whose profile
    // already holds their college should not be refused because a client
    // (the app, a script, a future mobile build) did not send it — the
    // profile is the answer, and this is where that is settled.
    const { answers: withMemory } = autofillFor(fields, profileMemoryFrom(profile), input.answers);

    // The client checks these too, for instant feedback. This is the copy
    // that decides — a hand-rolled POST gets the same answer.
    const problems = validateAnswers(fields, withMemory);
    if (Object.keys(problems).length > 0) {
      throw new ApiError(422, "missing-answers", Object.values(problems)[0] ?? "Some required details are missing.", problems);
    }

    const answers = cleanAnswers(fields, withMemory);

    const seats = input.members.length;
    const capacity = Number(event.capacity ?? 0);
    const registered = Number(event.registeredCount ?? 0);

    const openNow = isRegistrationOpen({
      registrationOpen: event.registrationOpen !== false,
      registrationDeadline: event.registrationDeadline,
      capacity,
      registeredCount: registered,
      status: event.status ?? "draft",
    });

    const wouldOverflow = capacity > 0 && registered + seats > capacity;
    const waitlist = wouldOverflow && event.waitlistEnabled === true;

    if (!openNow && !waitlist) {
      throw ApiError.unprocessable(
        capacity > 0 && registered >= capacity ? "This event is full." : "Registration for this event is closed.",
      );
    }
    if (wouldOverflow && !waitlist) {
      const left = Math.max(0, capacity - registered);
      throw ApiError.unprocessable(
        left === 0 ? "This event is full." : `Only ${left} ${left === 1 ? "seat" : "seats"} left — reduce the team size.`,
      );
    }

    // One active entry per person per event.
    const dup = await tx.get(
      db
        .collection(COLLECTIONS.registrations)
        .where("eventId", "==", input.eventId)
        .where("userId", "==", caller.uid)
        .where("status", "in", ["confirmed", "waitlisted", "pending_payment"])
        .limit(1),
    );
    if (!dup.empty) throw ApiError.conflict("You already hold an entry for this event.");

    // Teammates cannot be in two entries either. Firestore allows only one of
    // `in` / `array-contains-any` per query, so status is checked in memory.
    if (teammateEmails.length) {
      const clash = await tx.get(
        db
          .collection(COLLECTIONS.registrations)
          .where("eventId", "==", input.eventId)
          .where("memberEmails", "array-contains-any", teammateEmails.slice(0, 30)),
      );
      const active = clash.docs.find((d) => d.data().status !== "cancelled");
      if (active) {
        const taken = (active.data().memberEmails as string[]).find((e) => teammateEmails.includes(e));
        throw ApiError.conflict(`${taken} is already on another team for this event.`);
      }
    }

    // A paid event charges for a seat, never for a place in the queue: a
    // waitlisted entry is free until promotion. Whether this fest may take
    // payment at all is decided here, before anything is written — never by
    // quietly falling back to a free registration.
    const charge = !waitlist && eventRequiresPayment(event);
    let account: StoredAccount | null = null;
    if (charge) {
      const accountSnap = await tx.get(db.collection(COLLECTIONS.paymentAccounts).doc(String(event.festId)));
      account = assertOrderingAllowed(accountSnap.exists ? (accountSnap.data() as StoredAccount) : null);
    }

    const ticketCode = generateTicketCode(randomBytes);
    const regRef = db.collection(COLLECTIONS.registrations).doc();

    // Teammates start as invited: they confirm from their Teams page, and a
    // declined invitation hands the seat back.
    const invitedAt = Timestamp.now();
    const members = input.members.map((m, i) => {
      const email = i === 0 ? caller.email : m.email.toLowerCase();
      return compact({
        name: i === 0 ? leaderName : m.name.trim(),
        email,
        phone: i === 0 ? profile.phone ?? answers.phone : m.phone,
        studentId: i === 0 ? profile.studentId ?? profile.student?.studentId ?? answers.rollNumber : m.studentId,
        college: i === 0 ? profile.college ?? profile.student?.college ?? answers.college : m.college,
        userId: i === 0 ? caller.uid : userIdByEmail.get(email),
        isLeader: i === 0,
        inviteStatus: i === 0 ? "accepted" : "pending",
        invitedAt: i === 0 ? undefined : invitedAt,
      });
    });

    // A team that does not yet meet its minimum is a draft: it holds its
    // seats (losing them while the last teammate decides would be the worst
    // possible moment) but it is not a registration until enough people have
    // said yes. Everyone the leader lists starts as invited, so a team event
    // with a minimum above one always begins here.
    const complete = event.eventType !== "team" || teamIsComplete(members, teamSize);
    // A paid entry is `pending_payment` whatever the team looks like: it holds
    // its seats while the payment is made, and only the verified payment turns
    // it into a confirmed entry (or a draft, if the team is still short).
    const status = waitlist ? "waitlisted" : charge ? "pending_payment" : complete ? "confirmed" : "draft";
    const hold = charge && account ? writeHold(tx, db, { registrationId: regRef.id, eventId: input.eventId, festId: String(event.festId), userId: caller.uid, event, account }) : null;

    // A short code the leader can read out. Teams only — a solo entry has
    // nobody to join it.
    const joinCode = event.eventType === "team" ? generateJoinCode(randomBytes) : undefined;

    tx.set(
      regRef,
      compact({
        id: regRef.id,
        eventId: input.eventId,
        festId: event.festId,
        userId: caller.uid,
        type: event.eventType === "team" ? "team" : "solo",
        teamName: input.teamName?.trim() || undefined,
        members,
        // Flat copy for the "already on a team" query above; Firestore cannot
        // query inside an array of objects.
        memberEmails: members.map((m) => m.email),
        seats,
        ticketCode,
        ...(joinCode ? { joinCode } : {}),
        status,
        ...(hold ? { paymentStatus: hold.paymentStatus, amountPaise: hold.amountPaise, holdExpiresAt: hold.holdExpiresAt } : {}),
        eventTitle: event.title,
        userName: leaderName,
        userEmail: caller.email,
        ...(Object.keys(answers).length > 0 ? { answers } : {}),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }),
    );

    // A draft and an unpaid hold hold their seats exactly as a confirmed entry
    // does, so the counters move for all three. Only the waitlist takes nothing yet.
    if (status !== "waitlisted") {
      tx.update(eventRef, { registeredCount: FieldValue.increment(seats), updatedAt: FieldValue.serverTimestamp() });
      tx.update(db.collection(COLLECTIONS.fests).doc(String(event.festId)), {
        "stats.registrations": FieldValue.increment(seats),
      });
    }

    return { regRef, status, event, answers, fields };
  });

  const saved = await result.regRef.get();
  const registration = docToJson(saved)!;

  // Remember what they told us, so the next event's form arrives filled in.
  // Only fields the profile did not already hold; a registration answer never
  // rewrites a profile the student has edited themselves.
  const updates = profileUpdatesFrom(visibleFields(result.fields), result.answers, profileMemoryFrom(profile));
  if (Object.keys(updates).length > 0) {
    await userSnap.ref
      .set({ ...updates, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      .catch((error: unknown) => console.warn("[registrations] could not remember profile fields", error));
  }

  // Side effects after the transaction — none of these should be able to
  // roll back a seat that was correctly granted. (A paid entry is only asked to
  // pay here; its confirmation and teammate invitations follow the verified payment.)
  await announceRegistration(saved.id);

  return ok({ registration }, 201);
}, { rateLimit: RATE_LIMITS.authenticated.registration });
