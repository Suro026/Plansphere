import { z } from "zod";
import { PAYMENT_MODES, paymentProviderSchema } from "@/core/models/payment";
import { can } from "@/core/permissions";
import { ApiError, handler, ok, readBody, requireFestAccess, requirePermission } from "@/server/api";
import { audit } from "@/server/audit";
import { appUrl } from "@/server/email/templates";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { orderingBlocker, type StoredAccount } from "@/server/payments/account";
import { livePaymentsEnabled, paymentsEnabled } from "@/server/payments/config";
import { availableProviders, getAdapter, getSafeAdapter } from "@/server/payments/providers/registry";
import { assertSafeAccountChange, canConfigureCredentials, flagOpenPaymentsAfterChange, notifyPaymentAccountChange } from "@/server/payments/account-change";
import { PaymentConfigError, encryptCredentials } from "@/server/payments/secrets";
import { RATE_LIMITS } from "@/server/rate-limit";

/**
 * A fest's online-payment account.
 *
 *   GET   what an organizer may see: the platform switches, the providers this
 *         deployment supports, and the saved account's *non-secret* fields.
 *         Credentials are never returned — only whether they are saved.
 *   PUT   save the fest's own merchant credentials (encrypted, server-side
 *         only). The account lands in `pending_review`; paid events cannot be
 *         published until a platform administrator approves it.
 *   POST  { action: "approve" | "suspend" } — platform administrators only.
 *
 * Plansphere never holds a fest's money: the credentials are the fest's own
 * merchant account, and settlement is between that account and the fest.
 */

const saveSchema = z.object({
  provider: paymentProviderSchema,
  mode: z.enum(PAYMENT_MODES),
  merchantRef: z.string().trim().max(200).optional(),
  credentials: z.record(z.string(), z.string().trim().min(1).max(500)),
});

/**
 * Approving is a deliberate act on a specific set of credentials: the approver
 * says which version they looked at and which merchant the provider reported,
 * and the server refuses if either has changed since (someone saved different
 * credentials between the approver loading the page and clicking).
 */
const reviewSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), expectedVersion: z.number().int().min(0), confirmMerchantId: z.string().trim().min(1).max(200) }),
  z.object({ action: z.literal("suspend") }),
]);

const publicView = async (festId: string, caller: { uid: string; role: string }) => {
  const db = adminDb();
  const [accountSnap, secretSnap] = await Promise.all([db.collection(COLLECTIONS.paymentAccounts).doc(festId).get(), db.collection(COLLECTIONS.paymentSecrets).doc(festId).get()]);
  const account = accountSnap.exists ? (accountSnap.data() as StoredAccount & { updatedAt?: FirebaseFirestore.Timestamp; approvedAt?: FirebaseFirestore.Timestamp; updatedBy?: string }) : null;
  const fest = (await db.collection(COLLECTIONS.fests).doc(festId).get()).data() ?? {};
  return {
    // What this caller may do, so the screen shows only what will work.
    canConfigure: canConfigureCredentials(caller, fest),
    canApprove: can(caller.role as never, "payment:approve") && account?.updatedBy !== caller.uid,
    platform: { enabled: paymentsEnabled(), liveEnabled: livePaymentsEnabled() },
    providers: availableProviders().map((p) => ({ id: p.id, label: p.label, modes: p.modes, credentialFields: p.credentialFields })),
    account: account
      ? {
          provider: account.provider,
          mode: account.mode,
          status: account.status,
          merchantRef: account.merchantRef ?? null,
          // What the provider reported about these credentials — the approver checks it is the institution's own.
          merchantId: account.merchantId ?? null,
          merchantName: account.merchantName ?? null,
          credentialsVersion: account.credentialsVersion ?? 0,
          credentialsSaved: secretSnap.exists,
          updatedAt: account.updatedAt?.toMillis?.() ?? null,
          approvedAt: account.approvedAt?.toMillis?.() ?? null,
        }
      : null,
    available: orderingBlocker(account) === null,
    blocker: orderingBlocker(account),
    webhookUrl: account ? `${appUrl()}/api/payments/webhook/${account.provider}` : null,
  };
};

/** Loads the fest (404 if it is gone) and enforces fest scope. */
const festFor = async (id: string, caller: Parameters<typeof requireFestAccess>[0]) => {
  requireFestAccess(caller, id);
  const snap = await adminDb().collection(COLLECTIONS.fests).doc(id).get();
  if (!snap.exists) throw ApiError.notFound("That fest no longer exists.");
  return { data: snap.data() ?? {}, name: String(snap.data()?.name ?? "this fest") };
};

export const GET = handler(async (request, context) => {
  const caller = await requirePermission(request, "payment:configure");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing fest id.");
  await festFor(id, caller);
  return ok(await publicView(id, caller));
});

export const PUT = handler(
  async (request, context) => {
    const caller = await requirePermission(request, "payment:configure");
    const { id } = await context.params;
    if (!id) throw ApiError.badRequest("Missing fest id.");
    const fest = await festFor(id, caller);
    // Where payments go is decided by the fest's owner (or the platform), not by any admin of the fest.
    if (!canConfigureCredentials(caller, fest.data)) {
      throw ApiError.forbidden("Only the fest's owner or a platform administrator can change where payments go. Ask them to update the payment account.");
    }

    const input = await readBody(request, saveSchema);
    const adapter = getAdapter(input.provider);
    if (!adapter) throw ApiError.unprocessable("That payment provider isn't available on this deployment.");
    if (!adapter.modes.includes(input.mode)) throw ApiError.unprocessable(`${adapter.label} doesn't support ${input.mode} mode.`);

    // Exactly the fields the provider needs — nothing extra is accepted or stored.
    const allowed = new Set(adapter.credentialFields.map((f) => f.key));
    const extra = Object.keys(input.credentials).filter((k) => !allowed.has(k));
    if (extra.length) throw ApiError.badRequest("Some fields need fixing.", Object.fromEntries(extra.map((k) => [k, "Not a field this provider uses."])));
    const missing = adapter.credentialFields.filter((f) => !f.optional && !input.credentials[f.key]);
    if (missing.length) throw ApiError.badRequest("Some fields need fixing.", Object.fromEntries(missing.map((f) => [f.key, `${f.label} is required.`])));

    // Ask the provider whose credentials these are before anything is stored. The answer (not the organizer's
    // say-so) is what the approver sees and what payments are bound to.
    const safe = getSafeAdapter(input.provider)!;
    const check = await safe.verifyCredentials({ mode: input.mode, credentials: input.credentials });
    if (!check.ok) throw ApiError.unprocessable(`The provider didn't accept those credentials: ${check.reason}`);

    // Provider or mode may not change under money that is still open on the old account.
    const existingSnap = await adminDb().collection(COLLECTIONS.paymentAccounts).doc(id).get();
    const existing = existingSnap.exists ? (existingSnap.data() as StoredAccount) : null;
    await assertSafeAccountChange(id, existing, { provider: input.provider, mode: input.mode });

    let blob;
    try {
      blob = encryptCredentials(input.credentials, id);
    } catch (error) {
      if (error instanceof PaymentConfigError) throw new ApiError(503, "payment-secret-key-missing", "Payment credentials can't be stored on this deployment yet.");
      throw error;
    }

    const db = adminDb();
    const nextVersion = (existing?.credentialsVersion ?? 0) + 1;
    const batch = db.batch();
    batch.set(db.collection(COLLECTIONS.paymentSecrets).doc(id), { festId: id, blob, updatedAt: FieldValue.serverTimestamp(), updatedBy: caller.uid });
    // New or changed credentials always need a fresh look from a platform administrator — a different one from
    // whoever saved them (see the approval below).
    batch.set(db.collection(COLLECTIONS.paymentAccounts).doc(id), {
      festId: id,
      provider: input.provider,
      mode: input.mode,
      status: "pending_review",
      // Every save is a new version. Payments remember the version (and merchant) they were made under.
      credentialsVersion: nextVersion,
      merchantId: check.merchantId,
      merchantName: check.merchantName,
      ...(input.merchantRef ? { merchantRef: input.merchantRef } : {}),
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: caller.uid,
    });
    await batch.commit();

    // Anything still open that the new credentials do not provably belong to is held for review.
    const flagged = await flagOpenPaymentsAfterChange(id, { ...(existing ?? {}), festId: id, provider: input.provider, mode: input.mode, status: "pending_review", credentialsVersion: nextVersion, merchantId: check.merchantId, merchantName: check.merchantName } as StoredAccount);

    await audit(caller, {
      action: "payment_account_updated",
      summary: `Saved ${input.mode} payment account (${adapter.label}) for review`,
      festId: id,
      subjectType: "fest",
      subjectId: id,
      // Field names only, never values.
      details: { provider: input.provider, mode: input.mode, fields: Object.keys(input.credentials), merchantId: check.merchantId, version: nextVersion, paymentsFlaggedForReview: flagged },
    });
    await notifyPaymentAccountChange(id, caller.uid, "Payment account changed", `New ${input.mode} payment credentials were saved for ${fest.name} (merchant: ${check.merchantName}) and are waiting for approval.`);

    return ok(await publicView(id, caller));
  },
  { rateLimit: RATE_LIMITS.authenticated.staff },
);

export const POST = handler(
  async (request, context) => {
    const caller = await requirePermission(request, "payment:configure");
    const { id } = await context.params;
    if (!id) throw ApiError.badRequest("Missing fest id.");
    const fest = await festFor(id, caller);
    if (!can(caller.role, "payment:approve")) throw ApiError.forbidden("Only a platform administrator can approve or suspend a payment account.");

    const input = await readBody(request, reviewSchema);
    const db = adminDb();
    const ref = db.collection(COLLECTIONS.paymentAccounts).doc(id);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw ApiError.notFound("This fest hasn't saved a payment account yet.");
      const account = snap.data() as StoredAccount & { updatedBy?: string };
      const secret = await tx.get(db.collection(COLLECTIONS.paymentSecrets).doc(id));

      if (input.action === "suspend") {
        tx.update(ref, { status: "suspended", suspendedReason: "platform_administrator", updatedAt: FieldValue.serverTimestamp() });
        return;
      }

      if (!secret.exists) throw ApiError.unprocessable("The account has no saved credentials.");
      // The provider has to have told us who these credentials belong to; an account saved before that existed is re-saved first.
      if (!account.merchantId) throw ApiError.unprocessable("This account has no provider-verified merchant. Ask the fest owner to save the credentials again.");
      // Four eyes: whoever saved these credentials cannot also be the one who approves them.
      if (account.updatedBy === caller.uid) throw ApiError.forbidden("A different platform administrator has to approve credentials you saved.");
      // Approve exactly what was looked at — not whatever has been saved since.
      if ((account.credentialsVersion ?? 0) !== input.expectedVersion) throw ApiError.conflict("The credentials changed after you opened this page. Review the current merchant and approve again.");
      if (account.merchantId !== input.confirmMerchantId) throw ApiError.conflict("That isn't the merchant the provider reported for these credentials.");
      tx.update(ref, { status: "active", approvedAt: FieldValue.serverTimestamp(), approvedBy: caller.uid, approvedVersion: input.expectedVersion, updatedAt: FieldValue.serverTimestamp() });
    });

    const approved = input.action === "approve";
    await audit(caller, {
      action: approved ? "payment_account_approved" : "payment_account_suspended",
      summary: approved ? "Approved the fest's payment account" : "Suspended the fest's payment account",
      festId: id,
      subjectType: "fest",
      subjectId: id,
      ...(approved ? { details: { version: input.expectedVersion, merchantId: input.confirmMerchantId } } : {}),
    });
    await notifyPaymentAccountChange(id, caller.uid, approved ? "Payment account approved" : "Payment account suspended", approved ? `${fest.name} can now take online payments.` : `Online payments for ${fest.name} were switched off by a platform administrator.`);

    return ok(await publicView(id, caller));
  },
  { rateLimit: RATE_LIMITS.authenticated.staff },
);
