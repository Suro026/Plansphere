import { z } from "zod";
import { ApiError, handler, ok, requireFestAccess, requirePermission } from "@/server/api";
import { loadFestAnalytics } from "@/server/fest-analytics";

/**
 * GET /api/admin/analytics — one fest's Analytics & Reporting bundle.
 *
 * `audit:read` is the closest existing permission to "may read reporting
 * data for this fest" (every admin already has it); this route adds no new
 * capability to the permission matrix, only a new thing that capability can
 * read. Certificate download/verification counts come from
 * `certificateEvents`, a server-only collection with no client Firestore
 * rules, so this route is the only way any UI can see them — the fest page
 * cannot compute them itself the way it computes everything else live.
 */
const querySchema = z.object({
  festId: z.string().min(1),
  eventId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const GET = handler(async (request) => {
  const caller = await requirePermission(request, "audit:read");
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw ApiError.badRequest("Bad analytics request.");
  const { festId, eventId, from, to } = parsed.data;

  requireFestAccess(caller, festId);

  const bundle = await loadFestAnalytics(festId, { eventId, range: { from, to } });
  return ok(bundle);
});
