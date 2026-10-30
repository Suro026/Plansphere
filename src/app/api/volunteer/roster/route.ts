import { z } from "zod";
import { ApiError, handler, ok, requirePermission } from "@/server/api";
import { buildRoster, loadGateEvent } from "@/server/gate";

/**
 * GET /api/volunteer/roster?eventId=… — what the gate needs for one competition, and nothing more.
 *
 * For each entry: the ticket code, the holder's and team members' names, a masked email to tell two people apart, whether
 * the entry is admissible, and who is already ticked off. No phone number, college, student id, full email or
 * registration answer ever leaves the server on this route. The caller must be on the gate for this competition (or hold
 * a wider role on it).
 */
const querySchema = z.object({ eventId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });

export const GET = handler(async (request) => {
  const caller = await requirePermission(request, "attendance:scan");
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) throw ApiError.badRequest("Missing competition.");

  const event = await loadGateEvent(parsed.data.eventId);
  return ok(await buildRoster(caller, event));
});
