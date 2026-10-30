import { z } from "zod";
import { emailSchema } from "@/core/models/common";
import { emailFromBody, handler, ok, readBody } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";
import { passwordResetLink } from "@/server/auth-links";
import { emailService } from "@/server/email";
import { passwordResetEmail } from "@/server/email/templates";

/**
 * POST /api/auth/password-reset — send the reset email through our provider.
 *
 * Public and deliberately uninformative: it answers the same whether or not
 * the address has an account, so it cannot be used to enumerate users.
 * When no real provider is configured it says so (`fallback: true`) and the
 * client sends Firebase's own reset email instead — nobody is left without
 * a way back into their account because an API key is missing.
 */
export const POST = handler(async (request) => {
  const { email } = await readBody(request, z.object({ email: emailSchema }));
  const mailer = emailService();
  if (!mailer.canSend) return ok({ fallback: true });

  try {
    const user = await adminAuth().getUserByEmail(email);
    const profile = await adminDb().collection(COLLECTIONS.users).doc(user.uid).get();
    const link = await passwordResetLink(email);
    await mailer.send(
      passwordResetEmail({
        to: email,
        recipientName: String(profile.data()?.name ?? profile.data()?.fullName ?? user.displayName ?? "").trim() || undefined,
        resetLink: link,
        meta: { userId: user.uid, subjectType: "user", subjectId: user.uid },
      }),
    );
  } catch {
    // Unknown address, disabled account, or provider failure: same answer.
  }
  return ok({ fallback: false });
}, { rateLimit: [{ rule: RATE_LIMITS.auth.passwordReset, by: "ip" }, { rule: RATE_LIMITS.auth.passwordReset, by: emailFromBody }] });
