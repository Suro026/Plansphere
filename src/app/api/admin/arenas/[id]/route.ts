import { updateArenaSchema } from "@/core/models/arena";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { audit } from "@/server/audit";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { compact, docToJson } from "@/server/serialize";

export const PATCH = handler(async (request, context) => {
  const caller = await requirePermission(request, "match:manage");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing arena id.");

  const input = await readBody(request, updateArenaSchema);
  const db = adminDb();
  const ref = db.collection(COLLECTIONS.arenas).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw ApiError.notFound("That arena no longer exists.");
  const current = snap.data()!;
  requireFestAccess(caller, String(current.festId));

  await ref.update(compact({ ...input, updatedAt: FieldValue.serverTimestamp() }));

  await audit(caller, {
    action: "arena_updated",
    summary: `Arena "${current.name}" updated`,
    festId: String(current.festId),
    subjectType: "arena",
    subjectId: id,
  });

  const updated = await ref.get();
  return ok({ arena: docToJson(updated) });
});

export const DELETE = handler(async (request, context) => {
  const caller = await requirePermission(request, "match:manage");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing arena id.");

  const db = adminDb();
  const ref = db.collection(COLLECTIONS.arenas).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw ApiError.notFound("That arena no longer exists.");
  const current = snap.data()!;
  requireFestAccess(caller, String(current.festId));

  const inUse = await db.collection(COLLECTIONS.matches).where("arenaId", "==", id).limit(1).get();
  if (!inUse.empty) throw ApiError.unprocessable("This arena has matches assigned to it. Reassign them first, or mark the arena inactive instead.");

  await ref.delete();

  await audit(caller, {
    action: "arena_deleted",
    summary: `Arena "${current.name}" deleted`,
    festId: String(current.festId),
    subjectType: "arena",
    subjectId: id,
  });

  return ok({ id });
});
