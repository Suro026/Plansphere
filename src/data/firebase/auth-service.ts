import {
  applyActionCode,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  onIdTokenChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
  verifyPasswordResetCode,
  type User as FirebaseUser,
} from "firebase/auth";
import { FirebaseError } from "firebase/app";
import { USER_ROLES, type UserRole } from "@/core/models/user";
import { AuthError, type AuthErrorCode, type AuthService, type Session } from "@/core/services/auth-service";
import { firebaseAuth } from "./client";
import { api } from "@/data/api-client";

const CODE_MAP: Record<string, AuthErrorCode> = {
  "auth/invalid-credential": "invalid-credentials",
  "auth/wrong-password": "invalid-credentials",
  "auth/invalid-email": "invalid-credentials",
  "auth/user-not-found": "user-not-found",
  "auth/email-already-in-use": "email-in-use",
  "auth/weak-password": "weak-password",
  "auth/too-many-requests": "too-many-requests",
  "auth/network-request-failed": "network",
  "auth/expired-action-code": "expired-link",
  "auth/invalid-action-code": "expired-link",
  "auth/user-disabled": "user-disabled",
};

const MESSAGES: Record<AuthErrorCode, string> = {
  "invalid-credentials": "That email and password don't match.",
  "user-not-found": "No account with that email.",
  "email-in-use": "An account with that email already exists. Sign in instead.",
  "weak-password": "Use at least 8 characters with a mix of letters and numbers.",
  "too-many-requests": "Too many attempts. Wait a few minutes, or reset your password.",
  network: "Couldn't reach the server. Check your connection and try again.",
  "expired-link": "This link has expired or was already used. Request a new one.",
  "user-disabled": "This account has been disabled. Contact an organizer.",
  unknown: "Something went wrong. Please try again.",
};

const translate = (error: unknown): AuthError => {
  if (error instanceof AuthError) return error;
  const code = error instanceof FirebaseError ? (CODE_MAP[error.code] ?? "unknown") : "unknown";
  return new AuthError(code, MESSAGES[code]);
};

/** "organizer" is the pre-refactor name for "volunteer"; tokens outlive deploys. */
const roleFromClaim = (value: unknown): UserRole =>
  value === "organizer"
    ? "volunteer"
    : typeof value === "string" && (USER_ROLES as readonly string[]).includes(value)
      ? (value as UserRole)
      : "student";

const toSession = async (user: FirebaseUser, forceRefresh = false): Promise<Session> => {
  const token = await user.getIdTokenResult(forceRefresh);
  const festIds = Array.isArray(token.claims.festIds)
    ? (token.claims.festIds as unknown[]).filter((id): id is string => typeof id === "string")
    : [];

  return {
    uid: user.uid,
    email: (user.email ?? "").toLowerCase(),
    emailVerified: user.emailVerified,
    displayName: user.displayName,
    role: roleFromClaim(token.claims.role),
    festIds,
    memberLookup: token.claims.fx === true,
    memberFestIds: Array.isArray(token.claims.fm) ? (token.claims.fm as unknown[]).filter((id): id is string => typeof id === "string") : [],
    mustChangePassword: token.claims.mustChangePassword === true,
  };
};

/**
 * The application's own sign-in/sign-up throttle (see /api/auth/attempt).
 * "before" throws `too-many-requests` with the wait spelled out when the
 * account or this network is over its budget; "failed" reports a strike and
 * returns a message when that tipped it over; "succeeded" clears the
 * counters. A throttle-endpoint outage fails open — it must never be the
 * reason someone cannot sign in.
 */
const throttle = async (kind: "login" | "signup", email: string, phase: "before" | "failed" | "succeeded"): Promise<string | null> => {
  try {
    const res = await fetch("/api/auth/attempt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, email: email.trim(), phase }),
    });
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new AuthError("too-many-requests", body.error ?? "Too many attempts. Try again in a few minutes.");
    }
    if (phase === "failed" && res.ok) {
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      return body.ok === false && body.message ? body.message : null;
    }
    return null;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    return null;
  }
};

const actionUrl = (path: string): string =>
  `${process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin}${path}`;

export class FirebaseAuthService implements AuthService {
  getSession(): Promise<Session | null> {
    return new Promise((resolve) => {
      const stop = onIdTokenChanged(firebaseAuth(), async (user) => {
        stop();
        resolve(user ? await toSession(user) : null);
      });
    });
  }

  onSessionChange(listener: (session: Session | null) => void): () => void {
    // `onIdTokenChanged` rather than `onAuthStateChanged` so a claim change
    // (a student promoted to organizer) reaches the UI on the next refresh.
    return onIdTokenChanged(firebaseAuth(), async (user) => {
      listener(user ? await toSession(user) : null);
    });
  }

  async signIn(email: string, password: string): Promise<Session> {
    await throttle("login", email, "before");
    try {
      const credential = await signInWithEmailAndPassword(firebaseAuth(), email.trim(), password);
      void throttle("login", email, "succeeded");
      return await toSession(credential.user, true);
    } catch (error) {
      const translated = translate(error);
      if (translated.code === "invalid-credentials" || translated.code === "user-not-found") {
        const wait = await throttle("login", email, "failed");
        if (wait) throw new AuthError("too-many-requests", wait);
      }
      throw translated;
    }
  }

  async signUp(email: string, password: string, displayName: string): Promise<Session> {
    await throttle("signup", email, "before");
    try {
      const credential = await createUserWithEmailAndPassword(firebaseAuth(), email.trim(), password);
      void throttle("signup", email, "succeeded");
      await updateProfile(credential.user, { displayName: displayName.trim() });
      // The verification email is sent by the caller once the profile
      // document exists (see sendVerificationEmail), so it goes through our
      // own mailer and carries the person's name.
      return await toSession(credential.user);
    } catch (error) {
      throw translate(error);
    }
  }

  async signOut(): Promise<void> {
    await signOut(firebaseAuth());
  }

  /**
   * Our own mailer first (branded, logged, retried); Firebase's built-in
   * mailer when no provider is configured or the API is unreachable. Either
   * way the person gets a working link.
   */
  async sendVerificationEmail(): Promise<void> {
    const user = firebaseAuth().currentUser;
    if (!user) throw new AuthError("user-not-found", MESSAGES["user-not-found"]);
    const viaApi = await api<{ fallback: boolean }>("/api/auth/verification", { method: "POST" })
      .then((r) => !r.fallback)
      .catch(() => false);
    if (viaApi) return;
    try {
      await sendEmailVerification(user, { url: actionUrl("/verify-email?done=1") });
    } catch (error) {
      throw translate(error);
    }
  }

  async refreshSession(): Promise<Session | null> {
    const user = firebaseAuth().currentUser;
    if (!user) return null;
    await user.reload();
    return toSession(user, true);
  }

  async sendPasswordReset(email: string): Promise<void> {
    const viaApi = await api<{ fallback: boolean }>("/api/auth/password-reset", { method: "POST", auth: false, body: { email: email.trim() } })
      .then((r) => !r.fallback)
      .catch(() => false);
    if (viaApi) return;
    try {
      await sendPasswordResetEmail(firebaseAuth(), email.trim(), { url: actionUrl("/sign-in") });
    } catch (error) {
      const translated = translate(error);
      // Do not reveal whether an address exists: treat "not found" as success.
      if (translated.code === "user-not-found") return;
      throw translated;
    }
  }

  async verifyPasswordResetCode(code: string): Promise<string> {
    try {
      return await verifyPasswordResetCode(firebaseAuth(), code);
    } catch (error) {
      throw translate(error);
    }
  }

  async confirmPasswordReset(code: string, newPassword: string): Promise<void> {
    try {
      await confirmPasswordReset(firebaseAuth(), code, newPassword);
    } catch (error) {
      throw translate(error);
    }
  }

  async applyEmailVerification(code: string): Promise<void> {
    try {
      await applyActionCode(firebaseAuth(), code);
      await firebaseAuth().currentUser?.reload();
    } catch (error) {
      throw translate(error);
    }
  }

  async getIdToken(forceRefresh?: boolean): Promise<string | null> {
    const user = firebaseAuth().currentUser;
    return user ? user.getIdToken(forceRefresh) : null;
  }
}

export const authService = new FirebaseAuthService();
