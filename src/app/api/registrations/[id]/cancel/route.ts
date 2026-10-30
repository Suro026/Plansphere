import { ApiError, authenticate, handler, ok } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { announcePromoted, planCancellation, writeCancellation } from "@/server/payments/lifecycle";

/**
 * POST /api/registrations/[id]/cancel — a student withdraws their own entry.
 *
 * The seats go back to the pool in the same transaction, and if a waitlist
 * exists the earliest waitlisted entry that fits is promoted — which is the
 * only moment promotion can happen without racing the next sign-up.
 *
 * A paid entry is cancelled through the same code, which also records the
 * refund that is owed (for staff to approve); a student cancelling can never
 * walk away from, or around, a payment.
 */
export const POST = handler(async (request, context) => {
  const caller = await authenticate(request);
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing registration id.");

  const db = adminDb();
  const regRef = db.collection(COLLECTIONS.registrations).doc(id);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(regRef);
    if (!snap.exists) throw ApiError.notFound("That registration no longer exists.");

    const reg = snap.data()!;
    if (reg.userId !== caller.uid) throw ApiError.forbidden("Only the person who registered can cancel.");
    if (reg.status === "cancelled") return null;

    const eventSnap = await tx.get(db.collection(COLLECTIONS.events).doc(String(reg.eventId)));
    const event = eventSnap.data() ?? {};

    // Cancelling after the event has started is not a withdrawal; keep the
    // record honest for the college.
    if (event.status === "ongoing" || event.status === "completed") {
      throw ApiError.unprocessable("This event has already started, so the entry can't be cancelled.");
    }

    const plan = await planCancellation(tx, db, snap, eventSnap);
    return writeCancellation(tx, plan, "student");
  });

  await announcePromoted(result?.promoted ?? null);

  return ok({ cancelled: true, promoted: result?.promoted?.id ?? null, refundPending: result?.refundOwed ?? false });
}, { rateLimit: RATE_LIMITS.authenticated.registration });
