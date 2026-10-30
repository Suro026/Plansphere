import { ApiError, authenticate, handler, ok } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { emailVerificationLink } from "@/server/auth-links";
import { emailService } from "@/server/email";
import { emailVerificationEmail } from "@/server/email/templates";

/**
 * POST /api/auth/verification — (re)send the email-verification link to the
 * signed-in account through our provider. `fallback: true` tells the client
 * to use Firebase's built-in mailer when no provider is configured.
 */
export const POST = handler(async (request) => {
  const caller = await authenticate(request);
  if (caller.emailVerified) return ok({ fallback: false, alreadyVerified: true });

  const mailer = emailService();
  if (!mailer.canSend) return ok({ fallback: true });

  const profile = await adminDb().collection(COLLECTIONS.users).doc(caller.uid).get();
  const link = await emailVerificationLink(caller.email);
  const result = await mailer.send(
    emailVerificationEmail({
      to: caller.email,
      recipientName: String(profile.data()?.name ?? profile.data()?.fullName ?? "").trim() || undefined,
      verifyLink: link,
      meta: { userId: caller.uid, subjectType: "user", subjectId: caller.uid },
    }),
  );
  if (!result.ok) throw ApiError.unavailable("We couldn't send the email just now. Try again in a minute.");
  return ok({ fallback: false });
}, { rateLimit: [{ rule: RATE_LIMITS.auth.verification, by: "ip" }, { rule: RATE_LIMITS.auth.verification, by: "uid" }] });
