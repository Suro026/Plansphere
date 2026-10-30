import { updateMemberSchema } from "@/core/models/membership";
import { ApiError, handler, ok, readBody, requirePermission } from "@/server/api";
import { revokeMember, updateMember } from "@/server/membership";
import { RATE_LIMITS } from "@/server/rate-limit";

/**
 * Change or end one person's role on one main event. Who may touch whom is decided in `src/server/membership.ts`:
 * never yourself, never the head, and an admin only volunteers on their own competitions.
 */

/** PATCH /api/admin/fests/[id]/members/[uid] — change sub-events, duties or role, or suspend / reinstate. */
export const PATCH = handler(
  async (request, context) => {
    const caller = await requirePermission(request, "member:assignVolunteer");
    const { id, uid } = await context.params;
    if (!id || !uid) throw ApiError.badRequest("Missing event or person.");
    const patch = await readBody(request, updateMemberSchema);
    return ok(await updateMember(caller, id, uid, patch));
  },
  { rateLimit: RATE_LIMITS.authenticated.staff },
);

/** DELETE /api/admin/fests/[id]/members/[uid] — revoke their access. Takes effect on their very next request. */
export const DELETE = handler(
  async (request, context) => {
    const caller = await requirePermission(request, "member:assignVolunteer");
    const { id, uid } = await context.params;
    if (!id || !uid) throw ApiError.badRequest("Missing event or person.");
    return ok(await revokeMember(caller, id, uid));
  },
  { rateLimit: RATE_LIMITS.authenticated.staff },
);
