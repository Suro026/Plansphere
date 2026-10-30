import { z } from "zod";
import { ApiError, handler, ok, readBody, requirePermission } from "@/server/api";
import { audit } from "@/server/audit";
import { rewrapAllSecrets } from "@/server/payments/key-rotation";
import { PaymentConfigError } from "@/server/payments/secrets";
import { RATE_LIMITS } from "@/server/rate-limit";

const bodySchema = z.object({
  /** Defaults to true: report what would change without changing anything. */
  dryRun: z.boolean().default(true),
});

/**
 * POST /api/admin/payments/keys — move stored merchant credentials onto the
 * current encryption key and format (see `src/server/payments/secrets.ts`).
 *
 * Platform administrators only (`payment:approve`). A dry run, the default,
 * only reports. The response carries counts and fest ids — never a credential,
 * a key, or a ciphertext.
 */
export const POST = handler(
  async (request) => {
    const caller = await requirePermission(request, "payment:approve");
    const { dryRun } = await readBody(request, bodySchema);

    let report;
    try {
      report = await rewrapAllSecrets({ dryRun });
    } catch (error) {
      if (error instanceof PaymentConfigError) throw new ApiError(503, "payment-secret-key-missing", "The payment encryption key isn't configured on this deployment.");
      throw error;
    }

    if (!dryRun) {
      await audit(caller, {
        action: "payment_account_updated",
        summary: `Re-encrypted ${report.rewrapped} stored payment credential set${report.rewrapped === 1 ? "" : "s"} under the current key`,
        details: { keyId: report.currentKeyId, total: report.total, rewrapped: report.rewrapped, undecryptable: report.undecryptable.length },
      });
    }
    return ok({ report });
  },
  { rateLimit: RATE_LIMITS.authenticated.staff },
);
