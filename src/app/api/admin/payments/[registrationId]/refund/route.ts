import { z } from "zod";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { audit } from "@/server/audit";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { approveRefunds, releaseFlaggedHold, resolveReviewWithRefund } from "@/server/payments/lifecycle";
import { RATE_LIMITS } from "@/server/rate-limit";

const bodySchema = z.object({
  /**
   * approve: issue the refunds queued for staff · review: settle a flagged payment by returning the money ·
   * release: let go of an unpaid hold frozen by a change of the fest's merchant account.
   */
  action: z.enum(["approve", "review", "release"]),
});

/**
 * POST /api/admin/payments/[registrationId]/refund
 *
 * The only way staff move money back. Both actions are idempotent at the
 * provider (each refund has its own id), scoped to the fest the caller
 * manages, and audited.
 */
export const POST = handler(
  async (request, context) => {
    const caller = await requirePermission(request, "payment:refund");
    const { registrationId } = await context.params;
    if (!registrationId) throw ApiError.badRequest("Missing registration id.");
    const { action } = await readBody(request, bodySchema);

    const db = adminDb();
    const reg = await db.collection(COLLECTIONS.registrations).doc(registrationId).get();
    if (!reg.exists) throw ApiError.notFound("That registration no longer exists.");
    const data = reg.data()!;
    requireFestAccess(caller, String(data.festId));

    let summary: string;
    let result: unknown;
    if (action === "approve") {
      const done = await approveRefunds(registrationId).catch((error) => {
        if (error instanceof Error && error.message === "no-payment") throw ApiError.unprocessable("This registration has no payment.");
        throw error;
      });
      if (done.attempted === 0) throw ApiError.unprocessable("There is no refund waiting for approval.");
      if (done.results.every((r) => r === "blocked")) {
        throw ApiError.conflict("The fest's payment account changed after this payment was made, so the refund can't be sent from here. It has been flagged for review.");
      }
      summary = `Approved refund for ${data.teamName ?? data.userName} · ${data.ticketCode}`;
      result = done;
    } else if (action === "release") {
      if (!(await releaseFlaggedHold(registrationId))) throw ApiError.unprocessable("This payment isn't an unpaid hold frozen by an account change.");
      summary = `Released a frozen hold for ${data.teamName ?? data.userName} · ${data.ticketCode}`;
      result = { released: true };
    } else {
      // A payment in review either captured money that does not match (return it), or is an unpaid hold
      // frozen by an account change (nothing to return; let the seat go).
      const done = await resolveReviewWithRefund(registrationId);
      if (done) {
        summary = `Returned a flagged payment for ${data.teamName ?? data.userName} · ${data.ticketCode}`;
        result = done;
      } else if (await releaseFlaggedHold(registrationId)) {
        summary = `Released a frozen hold for ${data.teamName ?? data.userName} · ${data.ticketCode}`;
        result = { released: true };
      } else {
        throw ApiError.unprocessable("This payment isn't waiting for review.");
      }
    }

    await audit(caller, { action: "payment_refund_issued", summary, festId: String(data.festId), eventId: String(data.eventId), subjectType: "registration", subjectId: registrationId, details: { action } });
    return ok({ result });
  },
  { rateLimit: RATE_LIMITS.authenticated.staff },
);
