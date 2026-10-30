import type { PaymentAccountStatus, PaymentMode } from "@/core/models/payment";
import { ApiError } from "@/server/errors";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { livePaymentsEnabled, paymentsEnabled } from "./config";
import { getAdapter, getSafeAdapter } from "./providers/registry";
import type { PaymentProviderAdapter, ProviderContext } from "./providers/types";
import { decryptCredentials, type EncryptedBlob } from "./secrets";

/** A fest's payment account as stored (no secrets — those are in `paymentSecrets`). */
export interface StoredAccount {
  festId: string;
  provider: string;
  mode: PaymentMode;
  status: PaymentAccountStatus;
  merchantRef?: string;
  /**
   * Bumped every time credentials are saved. Each payment records the version it
   * was created under; money is only moved with credentials it was created with
   * (or that provably belong to the same merchant — see `bindingProblem`).
   */
  credentialsVersion?: number;
  /** Who the provider says these credentials belong to (from `verifyCredentials`). */
  merchantId?: string;
  merchantName?: string;
}

/** What a payment remembers about the account it was created under. */
export const accountBinding = (account: StoredAccount) => ({
  provider: account.provider,
  mode: account.mode,
  credentialsVersion: account.credentialsVersion ?? 0,
  ...(account.merchantId ? { merchantId: account.merchantId } : {}),
});

export type BindingProblem = "provider_changed" | "mode_changed" | "credentials_changed";

/**
 * Is it safe to use the fest's *current* credentials for this payment?
 *
 * Yes when provider and mode are unchanged and either the credentials are the
 * same version, or they were rotated within the same merchant (the provider
 * reported the same merchant id both times). Otherwise the answer is a reason,
 * and the caller must not contact the provider: an order made under one
 * merchant account cannot be verified, or refunded, with another's keys.
 */
export const bindingProblem = (
  pay: { provider?: unknown; mode?: unknown; credentialsVersion?: unknown; merchantId?: unknown },
  account: StoredAccount,
): BindingProblem | null => {
  if (pay.provider !== account.provider) return "provider_changed";
  if (pay.mode !== account.mode) return "mode_changed";
  if (Number(pay.credentialsVersion ?? 0) === Number(account.credentialsVersion ?? 0)) return null;
  if (typeof pay.merchantId === "string" && pay.merchantId && pay.merchantId === account.merchantId) return null;
  return "credentials_changed";
};

export const accountRef = (festId: string) => adminDb().collection(COLLECTIONS.paymentAccounts).doc(festId);

export const loadAccount = async (festId: string): Promise<StoredAccount | null> => {
  const snap = await accountRef(festId).get();
  return snap.exists ? (snap.data() as StoredAccount) : null;
};

/**
 * Why a fest cannot take payments right now, or null if it can.
 *
 * Every condition is a separate, visible switch: the platform flag, an approved
 * account, a registered provider, and — for `live` accounts — the live flag.
 * Nothing here is inferred, and no credential is touched.
 */
export const orderingBlocker = (account: StoredAccount | null | undefined): string | null => {
  if (!paymentsEnabled()) return "Online payment is not enabled for this deployment.";
  if (!account || account.status !== "active") return "This fest does not have an approved payment account.";
  if (account.mode === "live" && !livePaymentsEnabled()) return "Live payments are not enabled yet.";
  if (!getAdapter(account.provider)) return "This fest's payment provider is not available.";
  return null;
};

/** Throws a 422 an organizer or student can read. Never silently falls back to free. */
export const assertOrderingAllowed = (account: StoredAccount | null | undefined): StoredAccount => {
  const blocker = orderingBlocker(account);
  if (blocker) throw ApiError.unprocessable(`Online payment isn't available for this event right now. ${blocker}`);
  return account as StoredAccount;
};

/** The adapter and decrypted credentials for a fest. Decryption failures surface as a 503, not a leak. */
export const providerContextFor = async (account: StoredAccount): Promise<{ adapter: PaymentProviderAdapter; ctx: ProviderContext }> => {
  const adapter = getSafeAdapter(account.provider);
  if (!adapter) throw new ApiError(503, "payment-provider-unavailable", "This fest's payment provider is not available.");
  const snap = await adminDb().collection(COLLECTIONS.paymentSecrets).doc(account.festId).get();
  if (!snap.exists) throw new ApiError(503, "payment-credentials-missing", "This fest's payment account has no credentials.");
  try {
    const credentials = decryptCredentials((snap.data() as { blob: EncryptedBlob }).blob, account.festId);
    return { adapter, ctx: { mode: account.mode, credentials } };
  } catch {
    throw new ApiError(503, "payment-credentials-unreadable", "This fest's payment credentials could not be read.");
  }
};
