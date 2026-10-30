import { z } from "zod";
import { ApiError, handler, ok, requirePermission } from "@/server/api";
import { loadPlatformAnalytics } from "@/server/fest-analytics";

/**
 * GET /api/admin/platform/analytics — cross-fest analytics for the super
 * admin. `platform:manage` is the same gate the rest of `/admin/platform`
 * already uses.
 *
 * Defaults the range to the last 30 days when neither `from` nor `to` is
 * given — with no bound, this would read every registration and attendance
 * record on the platform, which is exactly the full-collection scan the
 * module is built to avoid. Pass an explicit range for a wider window.
 */
const querySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const GET = handler(async (request) => {
  await requirePermission(request, "platform:manage");
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw ApiError.badRequest("Bad analytics request.");

  const to = parsed.data.to ?? new Date();
  const from = parsed.data.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

  const bundle = await loadPlatformAnalytics({ from, to });
  return ok(bundle);
});
