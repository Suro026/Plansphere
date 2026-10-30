import { COLLECTIONS, FieldValue, adminAuth, adminDb } from "./firebase-admin";
import { ClaimsTooLargeError, buildClaims } from "@/core/claims";
import { memberCeiling } from "@/core/models/membership";
import type { UserRole } from "@/core/permissions";
import { ApiError } from "./errors";
import { loadActiveMemberships } from "./membership-store";

/**
 * Account credentials and custom claims — the one place either is written.
 *
 * The claim is what Firestore rules and every API route trust, so it must
 * never drift from the `users` document. `applyClaims` writes both together
 * and revokes existing tokens, which is what makes a demotion or a disable
 * take effect immediately rather than within the hour.
 */

export interface ClaimSet {
  role: UserRole;
  /** Fests a staff account may act on. Empty for students and super admins. */
  festIds: string[];
  /** Mirrored into the token so the client can route to the change screen. */
  mustChangePassword?: boolean;
}

/**
 * Sets the custom claims and revokes outstanding refresh tokens.
 *
 * Revoking matters: without it a demoted admin keeps their old claim on an
 * unexpired token for up to an hour, and `authenticate()` deliberately calls
 * `verifyIdToken(token, true)` so a revoked one is refused at once.
 */
export const applyClaims = async (uid: string, claims: ClaimSet, options: { revoke?: boolean } = {}): Promise<void> => {
  // Event-level memberships ride along on every claim write, whoever the caller is and whatever it was changing. This is
  // the one place claims are written, so a password reset or a role edit can never drop them. `core/claims.ts` decides what
  // goes in (and how it stays inside Firebase's size limit): the fests the account holds an event role on, listed or - for
  // an account with many - looked up by the rules; the role raised for the app and the base role for the rules.
  const memberships = await loadActiveMemberships(uid);

  let built;
  try {
    built = buildClaims({
      role: claims.role,
      festIds: claims.festIds,
      memberFestIds: memberships.map((member) => member.festId),
      ceiling: memberCeiling(memberships),
      mustChangePassword: claims.mustChangePassword,
    });
  } catch (error) {
    if (error instanceof ClaimsTooLargeError) {
      throw ApiError.unprocessable(
        "This account has access to too many events to fit in a sign-in token. Move its fest-wide access to event roles first (npm run migrate:memberships), then try again.",
      );
    }
    throw error;
  }

  await adminAuth().setCustomUserClaims(uid, built.claims);
  if (options.revoke !== false) await adminAuth().revokeRefreshTokens(uid);
};

/**
 * A temporary password for an invited staff account.
 *
 * Mailed once, usable only until the first sign-in completes: every
 * privileged route refuses while `mustChangePassword` is set, so the worst a
 * leaked invitation can do is set a password on an account that has not been
 * used yet — and the owner discovers that immediately, because theirs stops
 * working. Readable on purpose (no ambiguous characters): people retype these
 * from a phone.
 */
export const temporaryPassword = (): string => {
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const pick = (alphabet: string, count: number) => {
    const bytes = new Uint8Array(count);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  };
  // Three groups of four, e.g. "Mfpq-7tkr-Vw3n" — long enough to resist
  // guessing, short enough to type.
  return `${pick(upper, 1)}${pick(lower, 3)}-${pick(digits, 1)}${pick(lower, 3)}-${pick(upper, 1)}${pick(lower, 2)}${pick(digits, 1)}`;
};

/**
 * Marks an account as holding a temporary password, or clears the mark once
 * the person has chosen their own.
 */
export const setMustChangePassword = async (uid: string, value: boolean): Promise<void> => {
  const snapshot = await adminDb().collection(COLLECTIONS.users).doc(uid).get();
  const data = snapshot.data() ?? {};
  await adminDb()
    .collection(COLLECTIONS.users)
    .doc(uid)
    .set({ mustChangePassword: value, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await applyClaims(
    uid,
    {
      role: (data.role as UserRole) ?? "student",
      festIds: Array.isArray(data.festIds) ? (data.festIds as string[]) : [],
      mustChangePassword: value,
    },
    // Clearing the flag must not sign the person out of the session they are
    // sitting in; they have just proved they hold the account.
    { revoke: false },
  );
};
