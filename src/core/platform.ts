/**
 * The platform boundary: who is allowed to act as the platform.
 *
 * `super_admin` has always meant "the platform team", but it was only a role claim - one flag that anything able to mint a
 * claim, or to steal one super admin's password, turned into every power at once. The boundary adds a second, separate
 * condition that an event organizer's account can never satisfy: the account must be on the **platform registry**
 * (`platformStaff/{uid}`, written only by `npm run platform-staff` against the service account - there is no route, page or
 * rule that writes it), and, once enrolled, must have signed in with a second factor.
 *
 * It is staged so it can be rolled out without a lockout. `platformConfig/boundary` holds:
 *   - `enforce`:    false (default, and when the document is absent) = today's behaviour, the role claim alone;
 *                   true = a super admin who is not on the registry is treated as an ordinary account everywhere.
 *   - `requireMfa`: true = the registered super admin must also have signed in with a second factor (Firebase Identity
 *                   Platform TOTP). Do not turn this on before the platform team has enrolled; see docs/PLATFORM-BOUNDARY.md.
 *
 * The same decision is made in three places that must agree: here (the API), `firestore.rules` (`platformOk()`), and the
 * `platform-staff` script's lockout check. This is the pure version, tested against the same matrix as the rules.
 *
 * What it does NOT do: it does not make a role out of anything. Only an account that already carries `super_admin` can pass,
 * so an Event Head or any event role is never "granted" the platform by being listed here.
 */

export interface PlatformBoundary {
  enforce: boolean;
  requireMfa: boolean;
}

/** What the system does when `platformConfig/boundary` has never been written. */
export const OPEN_BOUNDARY: PlatformBoundary = { enforce: false, requireMfa: false };

export type PlatformStaffStatus = "active" | "suspended" | "removed";

export type PlatformDenial = "not-registered" | "suspended" | "second-factor-required";

export type PlatformDecision = { ok: true } | { ok: false; reason: PlatformDenial };

export const PLATFORM_DENIAL_MESSAGES: Record<PlatformDenial, string> = {
  "not-registered": "Platform access is not enabled for this account.",
  suspended: "Platform access is suspended for this account.",
  "second-factor-required": "Platform access requires signing in with a second factor.",
};

export const readBoundary = (data: Record<string, unknown> | undefined | null): PlatformBoundary => ({
  enforce: data?.enforce === true,
  requireMfa: data?.requireMfa === true,
});

export interface PlatformInput {
  boundary: PlatformBoundary;
  /** The account's registry entry, or null when it has none. */
  staff: { status?: unknown } | null;
  /** `firebase.sign_in_second_factor` from the verified ID token, when the sign-in used one. */
  secondFactor?: string | null | undefined;
}

export const decidePlatform = ({ boundary, staff, secondFactor }: PlatformInput): PlatformDecision => {
  if (!boundary.enforce) return { ok: true };
  if (!staff) return { ok: false, reason: "not-registered" };
  if (staff.status === "suspended") return { ok: false, reason: "suspended" };
  if (staff.status !== "active") return { ok: false, reason: "not-registered" };
  if (boundary.requireMfa && !secondFactor) return { ok: false, reason: "second-factor-required" };
  return { ok: true };
};
