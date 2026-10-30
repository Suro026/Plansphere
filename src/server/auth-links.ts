import { adminAuth } from "./firebase-admin";
import { appUrl } from "./email/templates";

/**
 * Action links (password reset, email verification) that land on our own
 * `/auth/action` page instead of Firebase's hosted handler.
 *
 * The Admin SDK mints the one-time `oobCode`; only the address it is wrapped
 * in changes. Doing this here means the emails work the same whether or not
 * the Console's "action URL" setting has been customised, and the link in the
 * email is a plansphere.in link rather than a firebaseapp.com one.
 */

const rebase = (firebaseLink: string, mode: string, continuePath: string): string => {
  const code = new URL(firebaseLink).searchParams.get("oobCode");
  if (!code) throw new Error("Firebase returned an action link without an oobCode");
  const url = new URL("/auth/action", appUrl());
  url.searchParams.set("mode", mode);
  url.searchParams.set("oobCode", code);
  url.searchParams.set("continueUrl", `${appUrl()}${continuePath}`);
  return url.toString();
};

export const passwordResetLink = async (email: string, continuePath = "/sign-in"): Promise<string> =>
  rebase(await adminAuth().generatePasswordResetLink(email, { url: `${appUrl()}${continuePath}` }), "resetPassword", continuePath);

export const emailVerificationLink = async (email: string, continuePath = "/verify-email?done=1"): Promise<string> =>
  rebase(await adminAuth().generateEmailVerificationLink(email, { url: `${appUrl()}${continuePath}` }), "verifyEmail", continuePath);

/** Staff invitations are a password reset that continues into the invite flow. */
export const staffInviteLink = (email: string): Promise<string> => passwordResetLink(email, "/set-password?invite=1");
