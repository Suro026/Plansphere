import { ApiError, handler, ok, requireFestAccess, requirePermission } from "@/server/api";
import { audit } from "@/server/audit";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { eventRefundWorkLeft, handleEventCancelled } from "@/server/payments/lifecycle";
import { RATE_LIMITS } from "@/server/rate-limit";

export const maxDuration = 60;

/**
 * GET  /api/admin/events/[id]/refunds — how much of a cancelled event's
 *      refund work is still outstanding.
 * POST /api/admin/events/[id]/refunds — carry on with it now.
 *
 * The payments job does this on its own schedule; this is the same work,
 * started by a person, for the cases where an organizer cannot wait for the
 * job or it has not been scheduled yet. Safe to call repeatedly: nothing is
 * released or refunded twice.
 */
const load = async (request: Request, context: { params: Promise<Record<string, string>> }) => {
  const caller = await requirePermission(request, "payment:refund");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing event id.");
  const snap = await adminDb().collection(COLLECTIONS.events).doc(id).get();
  if (!snap.exists) throw ApiError.notFound("That event no longer exists.");
  const event = snap.data()!;
  requireFestAccess(caller, String(event.festId));
  if (event.status !== "cancelled") throw ApiError.unprocessable("Only a cancelled event has refunds to finish.");
  return { caller, id, event };
};

export const GET = handler(async (request, context) => {
  const { id, event } = await load(request, context);
  return ok({ refundsPending: event.refundsPending === true, remaining: await eventRefundWorkLeft(id) });
});

export const POST = handler(
  async (request, context) => {
    const { caller, id, event } = await load(request, context);
    const result = await handleEventCancelled(id, { budgetMs: 40_000, retryStuck: true });
    await audit(caller, {
      action: "payment_refund_issued",
      summary: `Resumed refunds for cancelled event "${event.title}" — ${result.remaining === 0 ? "all done" : `${result.remaining} still to do`}`,
      festId: String(event.festId),
      eventId: id,
      subjectType: "event",
      subjectId: id,
      details: { released: result.released, refundsRecorded: result.refunds, remaining: result.remaining },
    });
    return ok(result);
  },
  { rateLimit: RATE_LIMITS.authenticated.staff },
);
