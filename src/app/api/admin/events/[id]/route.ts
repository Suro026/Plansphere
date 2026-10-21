import { updateEventSchema } from "@/core/models/event";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { audit } from "@/server/audit";
import { compact, docToJson } from "@/server/serialize";
import { emailService } from "@/server/email";
import { eventCancelledEmail, eventUpdatedEmail } from "@/server/email/templates";
import { activeParticipants, notifyMany } from "@/server/notify";
import { assertPaidEventAllowed } from "@/server/payments/event-rules";
import { handleEventCancelled } from "@/server/payments/lifecycle";

/**
 * PATCH /api/admin/events/[id] — edit an event.
 *
 * The guards here are the ones the design's settings screen states out loud:
 * "raising capacity is safe, lowering below 103 is refused", "team size
 * locked once a team registers". Each change that matters to the record
 * (capacity, status, registration window) is written to the audit log with
 * its before and after.
 */
export const PATCH = handler(async (request, context) => {
  const caller = await requirePermission(request, "event:update");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing event id.");

  const input = await readBody(request, updateEventSchema);
  const db = adminDb();
  const ref = db.collection(COLLECTIONS.events).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw ApiError.notFound("That event no longer exists.");

  const current = snap.data()!;
  requireFestAccess(caller, String(current.festId));

  const registered = Number(current.registeredCount ?? 0);

  if (input.capacity !== undefined && input.capacity > 0 && input.capacity < registered) {
    throw ApiError.unprocessable(
      `Capacity can't go below ${registered} — that many seats are already taken. Cancel entries first, or raise it.`,
    );
  }

  const hasEntries = registered > 0;
  const teamSizeChanged =
    input.teamSize !== undefined &&
    (input.teamSize.min !== current.teamSize?.min || input.teamSize.max !== current.teamSize?.max);
  const typeChanged = input.eventType !== undefined && input.eventType !== current.eventType;

  if (hasEntries && (teamSizeChanged || typeChanged)) {
    throw ApiError.unprocessable("Team size and entry type lock once the first team registers.");
  }

  // Online payment: the fee and the switch are fixed once anyone has registered (a ticket
  // that was free must never become paid, and the price of a paid one must not move under
  // people who already paid), and a paid event only goes live on an approved payment account.
  const paymentChanged = input.paymentEnabled !== undefined && input.paymentEnabled !== (current.paymentEnabled === true);
  const feeChanged = input.entryFee !== undefined && input.entryFee !== Number(current.entryFee ?? 0);
  if (paymentChanged || (feeChanged && current.paymentEnabled === true)) {
    const anyEntry = await db.collection(COLLECTIONS.registrations).where("eventId", "==", id).limit(1).get();
    if (!anyEntry.empty) throw ApiError.unprocessable("Online payment and the entry fee lock once the first person registers.");
  }
  const nextPaid = input.paymentEnabled ?? (current.paymentEnabled === true);
  const nextStatus = input.status ?? String(current.status ?? "draft");
  if (nextPaid && (paymentChanged || feeChanged || (nextStatus === "published" && current.status !== "published"))) {
    await assertPaidEventAllowed({
      festId: String(current.festId),
      paymentEnabled: nextPaid,
      entryFee: input.entryFee ?? Number(current.entryFee ?? 0),
      status: nextStatus,
      publishing: nextStatus === "published",
    });
  }

  if (input.slug !== undefined && input.slug !== current.slug) {
    const clash = await db
      .collection(COLLECTIONS.events)
      .where("festId", "==", current.festId)
      .where("slug", "==", input.slug)
      .limit(1)
      .get();
    if (!clash.empty) throw ApiError.conflict(`An event at "${input.slug}" already exists in this fest.`);
  }

  // Never let a client write the counter, whatever the body says.
  const { ...changes } = input as Record<string, unknown>;
  delete changes.registeredCount;

  // Cancelling a paid event owes money back. The obligation is written in the same update that cancels the
  // event, so it survives anything that happens afterwards in this request (a timeout, a failed email, a provider
  // outage): the payments job finishes it, and staff can resume it from the event.
  if (input.status === "cancelled" && current.status !== "cancelled" && current.paymentEnabled === true) {
    (changes as Record<string, unknown>).refundsPending = true;
  }

  // Archiving and restoring stamp the timestamp the way the fest-level
  // equivalent does — present while archived, cleared the moment it isn't.
  if (input.visibility === "archived" && current.visibility !== "archived") {
    (changes as Record<string, unknown>).archivedAt = FieldValue.serverTimestamp();
  } else if (input.visibility !== undefined && input.visibility !== "archived" && current.visibility === "archived") {
    (changes as Record<string, unknown>).archivedAt = FieldValue.delete();
  }

  await ref.update(compact({ ...changes, updatedAt: FieldValue.serverTimestamp() }));

  // Audit what matters, with before → after.
  const notes: string[] = [];
  if (input.capacity !== undefined && input.capacity !== current.capacity) {
    notes.push(`Capacity ${current.capacity ?? 0} → ${input.capacity}`);
  }
  if (input.status !== undefined && input.status !== current.status) {
    notes.push(`Status ${current.status} → ${input.status}`);
  }
  if (input.registrationOpen !== undefined && input.registrationOpen !== current.registrationOpen) {
    notes.push(`Registration ${input.registrationOpen ? "opened" : "closed"}`);
  }
  if (input.registrationDeadline !== undefined && input.registrationDeadline !== current.registrationDeadline) {
    notes.push(`Deadline → ${input.registrationDeadline}`);
  }
  if (input.visibility !== undefined && input.visibility !== current.visibility) {
    notes.push(`Visibility ${current.visibility ?? "public"} → ${input.visibility}`);
  }

  await audit(caller, {
    action:
      notes.some((n) => n.startsWith("Capacity")) ? "capacity_changed"
      : notes.some((n) => n.startsWith("Status")) ? "event_status_changed"
      : "event_updated",
    summary: notes.length ? `${current.title}: ${notes.join(" · ")}` : `Edited "${current.title}"`,
    festId: String(current.festId),
    eventId: id,
    subjectType: "event",
    subjectId: id,
    details: { changed: Object.keys(changes) },
  });

  // Tell the people holding tickets. Cancellation is its own message; a
  // change to when or where is an update; anything else (copy, poster,
  // capacity) is not worth an email.
  const cancelled = input.status === "cancelled" && current.status !== "cancelled";
  const logistics: string[] = [];
  if (input.date !== undefined && input.date !== current.date) logistics.push(`Date: ${current.date} → ${input.date}`);
  if (input.startTime !== undefined && input.startTime !== current.startTime) logistics.push(`Start time: ${current.startTime} → ${input.startTime}`);
  if (input.venue !== undefined && input.venue !== current.venue) logistics.push(`Venue: ${current.venue} → ${input.venue}`);

  if (cancelled || logistics.length) {
    const festName = String((await db.collection(COLLECTIONS.fests).doc(String(current.festId)).get()).data()?.name ?? "");
    const people = await activeParticipants({ eventId: id });
    const title = String(current.title);
    await notifyMany(
      people.map((r) => ({
        userId: r.userId,
        type: cancelled ? ("event_cancelled" as const) : ("event_updated" as const),
        title: cancelled ? `${title} has been cancelled` : `${title} has changed`,
        body: cancelled ? (current.paymentEnabled === true ? "Your entry no longer admits anyone. Anything you paid is being refunded in full." : "Your entry no longer admits anyone.") : logistics.join(" · "),
        link: cancelled ? "/my-events" : `/registered/${r.registrationId}`,
        festId: String(current.festId),
        eventId: id,
      })),
    );
    const meta = (r: { userId: string; registrationId: string }) => ({ userId: r.userId, festId: String(current.festId), eventId: id, subjectType: "registration", subjectId: r.registrationId });
    await emailService().sendMany(
      people.map((r) =>
        cancelled
          ? eventCancelledEmail({ to: r.email, recipientName: r.name, eventTitle: title, festName, meta: meta(r) })
          : eventUpdatedEmail({ to: r.email, recipientName: r.name, eventTitle: title, festName, changes: logistics, registrationId: r.registrationId, meta: meta(r) }),
      ),
    );
  }

  // A cancelled paid event: unpaid seat holds are released and every payment is refunded in full. Done here as far
  // as the time allows; whatever is left stays marked on the event (`refundsPending`) and the payments job continues.
  // A failure here must never turn a cancellation that has happened into an error for the organizer.
  if (cancelled && current.paymentEnabled === true) {
    await handleEventCancelled(id, { budgetMs: 20_000 }).catch((error: unknown) => console.warn("[payments] event cancellation will be finished by the payments job", error instanceof Error ? error.message : "unknown"));
  }

  const saved = await ref.get();
  return ok({ event: docToJson(saved) });
});

/**
 * DELETE /api/admin/events/[id]
 *
 * Refused while registrations exist — deleting an event out from under a
 * hundred issued tickets would orphan every one of them. Cancel the event
 * instead; that keeps the record and notifies the holders.
 */
export const DELETE = handler(async (request, context) => {
  const caller = await requirePermission(request, "event:delete");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing event id.");

  const db = adminDb();
  const ref = db.collection(COLLECTIONS.events).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw ApiError.notFound("That event no longer exists.");

  const event = snap.data()!;
  requireFestAccess(caller, String(event.festId));

  const entries = await db.collection(COLLECTIONS.registrations).where("eventId", "==", id).limit(1).get();
  if (!entries.empty) {
    throw ApiError.unprocessable(
      "This event has registrations, so it can't be deleted. Cancel it instead — tickets are revoked and holders notified, and the record is kept.",
    );
  }

  const batch = db.batch();
  batch.delete(ref);
  batch.update(db.collection(COLLECTIONS.fests).doc(String(event.festId)), {
    "stats.events": FieldValue.increment(-1),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  await audit(caller, {
    action: "event_deleted",
    summary: `Deleted "${event.title}"`,
    festId: String(event.festId),
    eventId: id,
    subjectType: "event",
    subjectId: id,
  });

  return ok({ deleted: true });
});
