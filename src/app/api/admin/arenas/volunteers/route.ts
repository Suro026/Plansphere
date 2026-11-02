import { ApiError, handler, ok, requireFestAccess, requirePermission } from "@/server/api";
import { listArenaVolunteers } from "@/server/live";

/**
 * GET /api/admin/arenas/volunteers?festId=… — who the Arenas page may offer under "Assign a volunteer".
 *
 * Everyone who could actually score at this fest: volunteers who hold an event role with the scoring duty, and volunteers
 * scoped to the fest the older way. The browser cannot build this list itself - an event-role volunteer's profile is not
 * readable from a client - and the assignment route applies the same rule, so nobody is offered who would then be refused.
 */
export const GET = handler(async (request) => {
  const caller = await requirePermission(request, "match:manage");
  const festId = new URL(request.url).searchParams.get("festId");
  if (!festId) throw ApiError.badRequest("Missing festId.");
  requireFestAccess(caller, festId);
  return ok({ volunteers: await listArenaVolunteers(festId) });
});
