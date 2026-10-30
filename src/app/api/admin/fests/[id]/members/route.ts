import { assignMemberSchema } from "@/core/models/membership";
import { ApiError, handler, ok, readBody, requirePermission } from "@/server/api";
import { assignMember, listMembers } from "@/server/membership";
import { RATE_LIMITS } from "@/server/rate-limit";

/**
 * The people who work on one main event, and the Event Head's (and an admin's) means of adding to them.
 *
 * Authority is decided in `src/server/membership.ts`, not here: the Event Head assigns admins, coordinators and
 * volunteers to any of the event's sub-events; an admin assigns volunteers to sub-events they are assigned to
 * themselves; nobody assigns themselves anything; there is no way to create a second head.
 */

/** GET /api/admin/fests/[id]/members */
export const GET = handler(async (request, context) => {
  const caller = await requirePermission(request, "member:assignVolunteer");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing event id.");
  return ok({ members: await listMembers(caller, id) });
});

/** POST /api/admin/fests/[id]/members — give someone a role on this event. */
export const POST = handler(
  async (request, context) => {
    const caller = await requirePermission(request, "member:assignVolunteer");
    const { id } = await context.params;
    if (!id) throw ApiError.badRequest("Missing event id.");
    const input = await readBody(request, assignMemberSchema);
    return ok(await assignMember(caller, id, input), 201);
  },
  { rateLimit: RATE_LIMITS.authenticated.staff },
);
