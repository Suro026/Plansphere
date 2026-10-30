import { ApiError, handler, ok, requireFestAccess, requirePermission } from "@/server/api";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { audit } from "@/server/audit";
import { activeParticipants, notifyMany } from "@/server/notify";
import { docToJson } from "@/server/serialize";

/**
 * POST /api/admin/events/[id]/results/publish
 *
 * Validates that every ranked entry is a confirmed, checked-in registration
 * for *this* event before it marks the sheet published — "only checked-in
 * teams can be ranked". Stamps the event and notifies every checked-in
 * participant. Certificate generation is a separate, explicit step.
 */
export const POST = handler(async (request, context) => {
  const caller = await requirePermission(request, "results:publish");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing event id.");

  const db = adminDb();
  const eventRef = db.collection(COLLECTIONS.events).doc(id);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) throw ApiError.notFound("That event no longer exists.");
  const event = eventSnap.data()!;
  requireFestAccess(caller, String(event.festId), id);

  const ref = db.collection(COLLECTIONS.results).doc(id);
  const sheet = await ref.get();
  if (!sheet.exists) throw ApiError.unprocessable("Save a result sheet first.");
  const entries = (sheet.data()!.entries ?? []) as Array<{ registrationId: string; displayName: string }>;
  if (entries.length === 0) throw ApiError.unprocessable("Add at least one placed entry before publishing.");

  // Every ranked entry must belong to this event and have been scanned in.
  for (const entry of entries) {
    const reg = await db.collection(COLLECTIONS.registrations).doc(entry.registrationId).get();
    if (!reg.exists || reg.data()!.eventId !== id) {
      throw ApiError.unprocessable(`"${entry.displayName}" is not a registration for this event.`);
    }
    if (reg.data()!.status === "cancelled") {
      throw ApiError.unprocessable(`"${entry.displayName}" cancelled their registration.`);
    }
    const att = await db.collection(COLLECTIONS.attendance).doc(entry.registrationId).get();
    if (!att.exists) {
      throw ApiError.unprocessable(`"${entry.displayName}" was never checked in, so they cannot be ranked.`);
    }
  }

  const batch = db.batch();
  batch.update(ref, {
    status: "published",
    publishedAt: FieldValue.serverTimestamp(),
    publishedBy: caller.uid,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.update(eventRef, { resultsPublishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();

  // Notify everyone who was there — leaders and teammates with accounts.
  const attended = await db.collection(COLLECTIONS.attendance).where("eventId", "==", id).get();
  const attendedRegIds = new Set(attended.docs.map((a) => a.id));
  const recipients = (await activeParticipants({ eventId: id })).filter((r) => attendedRegIds.has(r.registrationId));
  const notified = await notifyMany(
    recipients.map((r) => ({
      userId: r.userId,
      type: "results_published" as const,
      title: `Results are out — ${event.title}`,
      body: "See who placed. Certificates follow once the organizers issue them.",
      link: "/my-events",
      festId: String(event.festId),
      eventId: id,
    })),
  );

  await audit(caller, {
    action: "results_published",
    summary: `Published results for "${event.title}" · ${entries.length} placed · ${notified} participants notified`,
    festId: String(event.festId),
    eventId: id,
    subjectType: "result",
    subjectId: id,
  });

  return ok({ result: docToJson(await ref.get()) });
});
