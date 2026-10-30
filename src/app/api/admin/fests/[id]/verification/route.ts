import { z } from "zod";
import { ApiError, handler, ok, readBody, requirePermission } from "@/server/api";
import { approveApplication, rejectApplication } from "@/server/fest-verification";
import { audit } from "@/server/audit";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";

/**
 * POST /api/admin/fests/[id]/verification — decide a self-service event application.
 *
 * Only an account holding `fest:verify` (the platform's super admin) gets past the first line. It is deliberately NOT
 * scoped to a fest: the person who may approve an event is never the person who runs it. The decision itself, its
 * single-winner guarantee and the "not your own application" rule live in `src/server/fest-verification.ts`.
 *
 * The audit entry names the decision and the event, never a document, its path or the reviewer's reason beyond a word.
 */
const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("reject"), reason: z.string() }),
]);

export const POST = handler(async (request, context) => {
  const caller = await requirePermission(request, "fest:verify");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing event id.");
  const input = await readBody(request, decisionSchema);

  const festSnapshot = await adminDb().collection(COLLECTIONS.fests).doc(id).get();
  const name = String(festSnapshot.data()?.name ?? "this event");

  if (input.action === "approve") {
    const result = await approveApplication(id, caller);
    await audit(caller, {
      action: "fest_verification_approved",
      summary: `Approved "${name}"`.slice(0, 200),
      festId: id,
      subjectType: "fest",
      subjectId: id,
      details: { applicantId: result.applicantId, festRole: result.festRole },
    });
    return ok({ festId: id, status: "approved", ownerId: result.applicantId, festRole: result.festRole });
  }

  const result = await rejectApplication(id, caller, input.reason);
  await audit(caller, {
    action: "fest_verification_rejected",
    summary: `Rejected "${name}"`.slice(0, 200),
    festId: id,
    subjectType: "fest",
    subjectId: id,
    details: { applicantId: result.applicantId },
  });
  return ok({ festId: id, status: "rejected" });
});
