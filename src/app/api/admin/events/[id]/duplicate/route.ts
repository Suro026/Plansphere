import { duplicateEventFrom, eventSchema } from "@/core/models/event";
import { ApiError, handler, ok, requireFestAccess, requirePermission } from "@/server/api";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { audit } from "@/server/audit";
import { compact, docToJson, toDates } from "@/server/serialize";

/**
 * POST /api/admin/events/[id]/duplicate
 *
 * Copies an event's shape, never its history: no registrations, no counter,
 * a fresh slug, and it always lands as a draft with registration closed —
 * the coordinator reviews the copy (new date, new venue) before anyone can
 * sign up for it. Everything else — team size, gates, meal slots,
 * coordinators, the registration fields override — comes across so a
 * near-identical event (the next round of a recurring one) is one click and
 * a date change rather than a form filled out twice.
 */
export const POST = handler(async (request, context) => {
  const caller = await requirePermission(request, "event:create");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing event id.");

  const db = adminDb();
  const ref = db.collection(COLLECTIONS.events).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw ApiError.notFound("That event no longer exists.");

  const parsed = eventSchema.safeParse(toDates({ ...snap.data(), id: snap.id }));
  if (!parsed.success) throw ApiError.unprocessable("This event's record is in a shape the duplicator doesn't recognise.");
  const source = parsed.data;

  requireFestAccess(caller, source.festId);

  // The slug has to be unique in the fest; try "-copy", then "-copy-2", …
  let slug = `${source.slug}-copy`;
  for (let n = 2; n <= 20; n += 1) {
    const clash = await db.collection(COLLECTIONS.events).where("festId", "==", source.festId).where("slug", "==", slug).limit(1).get();
    if (clash.empty) break;
    slug = `${source.slug}-copy-${n}`;
  }

  const input = duplicateEventFrom(source, slug);
  const newRef = db.collection(COLLECTIONS.events).doc();
  const batch = db.batch();

  batch.set(
    newRef,
    compact({
      ...input,
      id: newRef.id,
      registeredCount: 0,
      createdBy: caller.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }),
  );
  batch.update(db.collection(COLLECTIONS.fests).doc(source.festId), { "stats.events": FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();

  await audit(caller, {
    action: "event_created",
    summary: `Duplicated "${source.title}" as "${input.title}"`,
    festId: source.festId,
    eventId: newRef.id,
    subjectType: "event",
    subjectId: newRef.id,
    details: { duplicatedFrom: id },
  });

  const saved = await newRef.get();
  return ok({ event: docToJson(saved) }, 201);
});
