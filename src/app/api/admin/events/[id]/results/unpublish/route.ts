import { ApiError, handler, ok, requireFestAccess, requirePermission } from "@/server/api";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { audit } from "@/server/audit";

/** POST /api/admin/events/[id]/results/unpublish — back to draft. */
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
  if (!sheet.exists) throw ApiError.notFound("No result sheet for this event.");
  if (sheet.data()!.certificatesGeneratedAt) {
    throw ApiError.unprocessable(
      "Certificates were already generated from this sheet. Revoke them first, or amend the sheet instead.",
    );
  }

  const batch = db.batch();
  batch.update(ref, {
    status: "draft",
    publishedAt: FieldValue.delete(),
    publishedBy: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.update(eventRef, { resultsPublishedAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();

  await audit(caller, {
    action: "results_unpublished",
    summary: `Unpublished results for "${event.title}"`,
    festId: String(event.festId),
    eventId: id,
    subjectType: "result",
    subjectId: id,
  });

  return ok({ unpublished: true });
});
