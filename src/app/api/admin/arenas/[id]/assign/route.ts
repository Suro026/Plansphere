import { z } from "zod";
import { idSchema } from "@/core/models/common";
import { ApiError, handler, ok, readBody, requirePermission } from "@/server/api";
import { assignArenaVolunteer } from "@/server/live";
import { RATE_LIMITS } from "@/server/rate-limit";

const bodySchema = z.object({ userId: idSchema });

/**
 * POST /api/admin/arenas/[id]/assign — roster a volunteer to score at this arena.
 *
 * Creates the scoring `Shift` that `requireArenaAccess` and the volunteer's live page both read. The person must be able to
 * score at the arena's fest (an event role with the scoring duty, or a fest-scoped volunteer); see `assignArenaVolunteer`.
 * 201 when a shift was written, 200 with `alreadyAssigned` when they already had one.
 */
export const POST = handler(
  async (request, context) => {
    const caller = await requirePermission(request, "match:manage");
    const { id } = await context.params;
    if (!id) throw ApiError.badRequest("Missing arena id.");
    const { userId } = await readBody(request, bodySchema);
    const { shift, created } = await assignArenaVolunteer(caller, id, userId);
    return ok({ shift, alreadyAssigned: !created }, created ? 201 : 200);
  },
  { rateLimit: RATE_LIMITS.authenticated.staff },
);
