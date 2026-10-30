import { updateMatchSchema } from "@/core/models/match";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { audit } from "@/server/audit";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { compact, docToJson } from "@/server/serialize";

/**
 * PATCH /api/admin/matches/[id] — admin edits to a match that are not
 * scoring actions: reassigning its arena, rescheduling it, correcting the
 * two sides, or overriding its status. Scoring itself, and the volunteer's
 * start/pause/resume/finish/undo, all go through
 * `/api/volunteer/matches/[id]/action` instead — that route is the one that
 * enforces arena scoping and writes the timeline.
 */
export const PATCH = handler(async (request, context) => {
  const caller = await requirePermission(request, "match:manage");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing match id.");

  const input = await readBody(request, updateMatchSchema);
  const db = adminDb();
  const ref = db.collection(COLLECTIONS.matches).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw ApiError.notFound("That match no longer exists.");
  const current = snap.data()!;
  requireFestAccess(caller, String(current.festId), String(current.eventId));

  let arenaName: string | undefined;
  if (input.arenaId !== undefined) {
    if (input.arenaId) {
      const arenaSnap = await db.collection(COLLECTIONS.arenas).doc(input.arenaId).get();
      if (!arenaSnap.exists || String(arenaSnap.data()?.festId) !== String(current.festId)) throw ApiError.badRequest("That arena does not belong to this fest.");
      arenaName = String(arenaSnap.data()?.name ?? "");
    } else {
      arenaName = undefined;
    }
  }

  await ref.update(
    compact({
      ...input,
      arenaName: input.arenaId !== undefined ? arenaName : undefined,
      updatedAt: FieldValue.serverTimestamp(),
    }),
  );

  await audit(caller, {
    action: "match_updated",
    summary: `Match updated`,
    festId: String(current.festId),
    eventId: String(current.eventId),
    subjectType: "match",
    subjectId: id,
  });

  const updated = await ref.get();
  return ok({ match: docToJson(updated) });
});
