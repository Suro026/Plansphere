"use client";

import { getToken, initializeAppCheck, ReCaptchaV3Provider, type AppCheck } from "firebase/app-check";
import { firebaseApp } from "./client";

/**
 * Firebase App Check (reCAPTCHA v3) on the client.
 *
 * Activated only when NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY is set, so a fresh
 * checkout works without it. Once active, the token is attached to every
 * `api()` call and used by Firestore/Storage automatically.
 */

let instance: AppCheck | null | undefined;

export const appCheck = (): AppCheck | null => {
  if (instance !== undefined) return instance;
  const siteKey = process.env.NEXT_PUBLIC_RECAPTCHA_V3_SITE_KEY;
  if (typeof window === "undefined" || !siteKey) {
    instance = null;
    return instance;
  }
  try {
    if (process.env.NEXT_PUBLIC_APPCHECK_DEBUG === "1") {
      (window as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }
    instance = initializeAppCheck(firebaseApp(), { provider: new ReCaptchaV3Provider(siteKey), isTokenAutoRefreshEnabled: true });
  } catch (error) {
    console.warn("[app-check] not initialised:", error instanceof Error ? error.message : error);
    instance = null;
  }
  return instance;
};

/** The current App Check token, or null when App Check is off or unavailable. */
export const appCheckToken = async (): Promise<string | null> => {
  const ac = appCheck();
  if (!ac) return null;
  try {
    return (await getToken(ac, false)).token;
  } catch {
    return null;
  }
};
