import { z } from "zod";
import { mealTypeSchema } from "@/core/models/attendance";
import { handler, ok, readBody, requirePermission } from "@/server/api";
import { loadGateEvent, requireGateDuty, serveMeal } from "@/server/gate";

/**
 * POST /api/volunteer/meal — hand out a meal at a counter.
 *
 * The caller must hold the meal duty for this competition. One document per member per round, so a second helping is a
 * refusal rather than a count two counters could race past.
 */
const bodySchema = z.object({
  eventId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  ticketCode: z.string().trim().min(3).max(40),
  mealType: mealTypeSchema,
  servedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memberKeys: z.array(z.string().regex(/^[0-9a-f]{8}$/)).max(60).optional(),
  post: z.string().trim().max(200).optional(),
  scannedAt: z.number().int().positive().optional(),
});

export const POST = handler(async (request) => {
  const caller = await requirePermission(request, "meal:scan");
  const input = await readBody(request, bodySchema);

  const event = await loadGateEvent(input.eventId);
  requireGateDuty(caller, event, "meal:scan");
  return ok(await serveMeal(caller, event, input));
});
