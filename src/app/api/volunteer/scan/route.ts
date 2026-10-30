import { z } from "zod";
import { handler, ok, readBody, requirePermission } from "@/server/api";
import { loadGateEvent, requireGateDuty, scanEntry } from "@/server/gate";

/**
 * POST /api/volunteer/scan — record an entry at the gate.
 *
 * The caller must hold the entry duty for this competition. The server resolves the ticket within the competition's own
 * fest, applies the one admission rule, and writes the check-in in a transaction: one record per entry however often its
 * code is scanned, and a team arriving in waves extends it. A scan made offline carries the time it was made.
 */
const bodySchema = z.object({
  eventId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  ticketCode: z.string().trim().min(3).max(40),
  memberKeys: z.array(z.string().regex(/^[0-9a-f]{8}$/)).max(60).optional(),
  gate: z.string().trim().max(200).optional(),
  scannedAt: z.number().int().positive().optional(),
});

export const POST = handler(async (request) => {
  const caller = await requirePermission(request, "attendance:scan");
  const input = await readBody(request, bodySchema);

  const event = await loadGateEvent(input.eventId);
  requireGateDuty(caller, event, "attendance:scan");
  return ok(await scanEntry(caller, event, input));
});
