import { ApiError, authenticate, handler, ok } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { ensureCheckout } from "@/server/payments/checkout";

/**
 * POST /api/registrations/[id]/payment — start (or resume) the checkout for a
 * seat that is waiting for payment.
 *
 * Takes no body: the amount, currency and order all come from the server's own
 * records, so there is nothing for a client to tamper with. Safe to call again
 * (reload, second tab): it returns the same order. If the payment has in fact
 * already gone through, the entry is confirmed here and `{ state: "paid" }` is
 * returned.
 */
export const POST = handler(async (request, context) => {
  const caller = await authenticate(request);
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing registration id.");

  const result = await ensureCheckout(id, caller.uid);
  return ok(result);
}, { rateLimit: RATE_LIMITS.authenticated.checkout });
