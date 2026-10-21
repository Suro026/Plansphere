/**
 * Platform-level payment switches. Every one defaults to OFF: with none of these
 * set, no order can be created and no paid event can be published.
 *
 *   PAYMENTS_ENABLED            "1" lets approved fests create orders at all.
 *   PAYMENTS_LIVE_ENABLED       "1" additionally allows accounts in `live` mode.
 *                               Leave unset until the provider arrangement is
 *                               verified (see docs/payments-implementation.md).
 *   PAYMENTS_ALLOW_TEST_PROVIDER "1" registers the in-repo test provider. Ignored
 *                               when NODE_ENV is "production" — it can never exist there.
 *   PAYMENT_HOLD_MINUTES        how long an unpaid seat is held (default 15, 5–60).
 *   PAYMENT_SECRET_KEY          base64 of 32 random bytes; encrypts stored merchant
 *                               credentials. See secrets.ts.
 *
 * Read at call time (not import time) so tests and a redeploy see changes.
 */

export const paymentsEnabled = (): boolean => process.env.PAYMENTS_ENABLED === "1";

export const livePaymentsEnabled = (): boolean => process.env.PAYMENTS_LIVE_ENABLED === "1";

export const testProviderAllowed = (): boolean => process.env.NODE_ENV !== "production" && process.env.PAYMENTS_ALLOW_TEST_PROVIDER === "1";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const holdMinutes = (): number => {
  const raw = Number(process.env.PAYMENT_HOLD_MINUTES ?? 15);
  return clamp(Number.isFinite(raw) ? Math.floor(raw) : 15, 5, 60);
};

/** An expired hold whose provider cannot be reached is released after this long regardless. */
export const PROVIDER_UNREACHABLE_GRACE_MS = 60 * 60 * 1000;

/** A pending payment older than this is re-checked with the provider by the reconciliation job. */
export const RECONCILE_AFTER_MS = 10 * 60 * 1000;
