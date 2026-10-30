import { changePasswordSchema } from "@/core/models/user";
import { ApiError, authenticate, handler, ok, readBody } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { setMustChangePassword } from "@/server/credentials";
import { adminAuth } from "@/server/firebase-admin";
import { audit } from "@/server/audit";

/**
 * POST /api/auth/change-password
 *
 * The one route a `mustChangePassword` account may call — it does not use
 * `requireRole`, which refuses while the flag is set, only `authenticate`.
 *
 * The current password is re-verified against Firebase before the change, so
 * a stolen session cannot silently take an account over: whoever changes the
 * password must know the one in force. After the change the flag is cleared
 * and the new password takes effect on the session already in hand.
 */
export const POST = handler(async (request) => {
  const caller = await authenticate(request);
  const input = await readBody(request, changePasswordSchema);

  // Re-authenticate with Identity Toolkit: the Admin SDK can set a password
  // but cannot check one.
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!apiKey) throw ApiError.unavailable("Password changes are not available on this deployment.");

  // Against the Auth emulator when the Admin SDK is pointed at one (development and the test suite), so the flow can be
  // exercised without reaching Google; otherwise the real endpoint, exactly as before.
  const emulatorHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const identityToolkit = emulatorHost ? `http://${emulatorHost}/identitytoolkit.googleapis.com` : "https://identitytoolkit.googleapis.com";
  const verify = await fetch(`${identityToolkit}/v1/accounts:signInWithPassword?key=${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: caller.email, password: input.currentPassword, returnSecureToken: false }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  if (!verify?.ok) {
    throw ApiError.unprocessable("That is not your current password.");
  }

  await adminAuth().updateUser(caller.uid, { password: input.password });
  await setMustChangePassword(caller.uid, false);

  await audit(caller, {
    action: "password_changed",
    summary: "Changed their own password",
    subjectType: "user",
    subjectId: caller.uid,
  });

  return ok({ ok: true });
}, { rateLimit: RATE_LIMITS.auth.passwordReset });
