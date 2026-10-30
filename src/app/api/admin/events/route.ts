import { createEventSchema } from "@/core/models/event";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { audit } from "@/server/audit";
import { compact, docToJson } from "@/server/serialize";
import { assertPaidEventAllowed } from "@/server/payments/event-rules";

/**
 * POST /api/admin/events — create an event in a fest the caller manages.
 *
 * Server-side so the fest's public event counter and the audit entry are
 * written in the same batch as the event, and so slug uniqueness is checked
 * against the live collection rather than a client's stale view.
 */
export const POST = handler(async (request) => {
  const caller = await requirePermission(request, "event:create");
  const input = await readBody(request, createEventSchema);
  requireFestAccess(caller, input.festId);

  const db = adminDb();

  const fest = await db.collection(COLLECTIONS.fests).doc(input.festId).get();
  if (!fest.exists) throw ApiError.notFound("That fest no longer exists.");

  // Online payment is opt-in per event, and a paid event can only go live on a fest with an approved payment account.
  await assertPaidEventAllowed({ festId: input.festId, paymentEnabled: input.paymentEnabled, entryFee: input.entryFee, status: input.status, publishing: input.status === "published" });

  const clash = await db
    .collection(COLLECTIONS.events)
    .where("festId", "==", input.festId)
    .where("slug", "==", input.slug)
    .limit(1)
    .get();
  if (!clash.empty) throw ApiError.conflict(`An event at "${input.slug}" already exists in this fest.`);

  const ref = db.collection(COLLECTIONS.events).doc();
  const batch = db.batch();

  batch.set(
    ref,
    compact({
      ...input,
      id: ref.id,
      registeredCount: 0,
      createdBy: caller.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }),
  );
  batch.update(fest.ref, { "stats.events": FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();

  await audit(caller, {
    action: "event_created",
    summary: `Created "${input.title}"${input.status === "published" ? " (published)" : " (draft)"}`,
    festId: input.festId,
    eventId: ref.id,
    subjectType: "event",
    subjectId: ref.id,
  });

  const saved = await ref.get();
  return ok({ event: docToJson(saved) }, 201);
});
