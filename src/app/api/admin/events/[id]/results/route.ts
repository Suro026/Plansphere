import { z } from "zod";
import { resultEntrySchema } from "@/core/models/result";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { audit } from "@/server/audit";
import { compact, docToJson } from "@/server/serialize";

const bodySchema = z.object({
  entries: z.array(resultEntrySchema).max(100),
});

/**
 * PUT /api/admin/events/[id]/results — save the result sheet.
 *
 * One sheet per event, keyed by the event id. Saving never changes the
 * published state: an already-published sheet that is saved again becomes an
 * amendment (kept published, `amendedAt` stamped) rather than silently
 * flipping back to draft — the canvas: "a correction is shown as an amendment
 * rather than a silent edit."
 */
export const PUT = handler(async (request, context) => {
  const caller = await requirePermission(request, "results:publish");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing event id.");
  const { entries } = await readBody(request, bodySchema);

  const db = adminDb();
  const eventSnap = await db.collection(COLLECTIONS.events).doc(id).get();
  if (!eventSnap.exists) throw ApiError.notFound("That event no longer exists.");
  const event = eventSnap.data()!;
  requireFestAccess(caller, String(event.festId), id);

  const ids = entries.map((e) => e.registrationId);
  if (new Set(ids).size !== ids.length) throw ApiError.unprocessable("The same entry is listed twice.");

  const ref = db.collection(COLLECTIONS.results).doc(id);
  const existing = await ref.get();
  const wasPublished = existing.exists && existing.data()!.status === "published";

  await ref.set(
    compact({
      id,
      eventId: id,
      festId: event.festId,
      entries,
      status: wasPublished ? "published" : "draft",
      ...(wasPublished ? { amendedAt: FieldValue.serverTimestamp(), amendedBy: caller.uid } : {}),
      ...(existing.exists ? {} : { createdBy: caller.uid, createdAt: FieldValue.serverTimestamp() }),
      updatedAt: FieldValue.serverTimestamp(),
    }),
    { merge: true },
  );

  await audit(caller, {
    action: "results_saved",
    summary: `${wasPublished ? "Amended published" : "Saved draft"} results for "${event.title}" (${entries.length} placed)`,
    festId: String(event.festId),
    eventId: id,
    subjectType: "result",
    subjectId: id,
  });

  return ok({ result: docToJson(await ref.get()) });
});
