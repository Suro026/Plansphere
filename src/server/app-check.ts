import { getAppCheck } from "firebase-admin/app-check";
import { getAdminApp, isAdminConfigured } from "./firebase-admin";

/**
 * Firebase App Check on our own API routes.
 *
 * The client attaches `X-Firebase-AppCheck` (see data/api-client.ts) when a
 * reCAPTCHA v3 site key is configured. Two modes, chosen by APP_CHECK_ENFORCE:
 *
 *   monitor (default) — verify when present, log when missing or invalid,
 *                       never refuse. This is how a rollout is watched.
 *   enforced          — refuse requests without a valid token.
 *
 * Firestore/Storage enforcement is a separate switch in the Firebase console;
 * this covers the routes the console cannot see.
 */

export type AppCheckVerdict = "valid" | "missing" | "invalid" | "skipped";

export const appCheckMode = (): "enforced" | "monitor" => (process.env.APP_CHECK_ENFORCE === "true" ? "enforced" : "monitor");

export const verifyAppCheck = async (request: Request): Promise<AppCheckVerdict> => {
  const token = request.headers.get("x-firebase-appcheck");
  if (!token) return "missing";
  if (!isAdminConfigured() || process.env.FIRESTORE_EMULATOR_HOST) return "skipped";
  try {
    await getAppCheck(getAdminApp()).verifyToken(token);
    return "valid";
  } catch {
    return "invalid";
  }
};
