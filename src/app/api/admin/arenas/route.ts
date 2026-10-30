import { createArenaSchema } from "@/core/models/arena";
import { handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { audit } from "@/server/audit";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { compact, docToJson } from "@/server/serialize";

/**
 * POST /api/admin/arenas — create an arena ("Arena A", "Robo Cage") a fest's
 * matches get assigned to. Writes go through here rather than the client so
 * every arena has an audit entry, the same as every other fest fixture.
 */
export const POST = handler(async (request) => {
  const caller = await requirePermission(request, "match:manage");
  const input = await readBody(request, createArenaSchema);
  requireFestAccess(caller, input.festId);

  const db = adminDb();
  const ref = db.collection(COLLECTIONS.arenas).doc();
  await ref.set(
    compact({
      id: ref.id,
      festId: input.festId,
      name: input.name,
      location: input.location,
      active: true,
      createdBy: caller.uid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }),
  );

  await audit(caller, {
    action: "arena_created",
    summary: `Arena "${input.name}" created`,
    festId: input.festId,
    subjectType: "arena",
    subjectId: ref.id,
  });

  const snap = await ref.get();
  return ok({ arena: docToJson(snap) }, 201);
});
