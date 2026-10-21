import { ApiError } from "@/server/errors";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { appUrl } from "@/server/email/templates";
import { assertOrderingAllowed, bindingProblem, loadAccount, providerContextFor } from "./account";
import { applyOrderSnapshot, flagBindingProblem, paymentRef } from "./lifecycle";
import { OrderTerminalError, type CheckoutSession } from "./providers/types";

export type CheckoutResult =
  | { state: "checkout"; checkout: CheckoutSession; orderId: string; amountPaise: number; expiresAt: number }
  | { state: "paid" };

const millis = (value: unknown): number => (value && typeof (value as { toMillis?: () => number }).toMillis === "function" ? (value as { toMillis: () => number }).toMillis() : 0);

const cleanPhone = (value: unknown): string | undefined => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits.slice(-10) : undefined;
};

/**
 * Gives the signed-in owner of a `pending_payment` entry something to pay.
 *
 * Idempotent: calling it twice (a double click, a reload, two tabs) returns the
 * same order. If the customer already paid but the confirmation has not landed
 * yet, it is applied here — after the provider's own record is read — and the
 * caller is told the entry is paid instead of being sent to pay again.
 *
 * The amount comes from the payment record written when the hold was made,
 * never from the request.
 */
export const ensureCheckout = async (registrationId: string, userId: string): Promise<CheckoutResult> => {
  const db = adminDb();
  const regRef = db.collection(COLLECTIONS.registrations).doc(registrationId);
  const [regSnap, paySnap] = await Promise.all([regRef.get(), paymentRef(db, registrationId).get()]);

  // Same answer for "not yours" and "does not exist".
  if (!regSnap.exists || regSnap.data()!.userId !== userId) throw ApiError.notFound("We couldn't find that registration.");
  const reg = regSnap.data()!;

  if (reg.status === "confirmed" && reg.paymentStatus === "paid") return { state: "paid" };
  if (reg.status !== "pending_payment" || !paySnap.exists) throw ApiError.conflict("This registration doesn't need a payment.");
  if (millis(reg.holdExpiresAt) <= Date.now()) throw ApiError.conflict("Your seat hold has expired. Register again to get a new one.");

  const account = assertOrderingAllowed(await loadAccount(String(reg.festId)));
  let pay = paySnap.data()!;

  // A hold made under one merchant account is never continued under another: the order lives with the
  // first one. It goes to review and the person is told plainly; nothing is sent to the provider.
  const problem = bindingProblem(pay, account);
  if (problem) {
    await flagBindingProblem(registrationId, problem);
    throw ApiError.conflict("This payment is on hold for review because the fest's payment account changed. Your seat stays held while the organizers sort it out.");
  }
  const { adapter, ctx } = await providerContextFor(account);

  // Already paid at the provider but not yet confirmed here?
  if (pay.status === "pending" || pay.status === "created") {
    const snapshot = await adapter.fetchOrder(ctx, String(pay.orderId)).catch(() => null);
    if (snapshot && snapshot.status === "paid") {
      const outcome = await applyOrderSnapshot(registrationId, snapshot);
      if (outcome.kind === "confirmed" || outcome.kind === "reinstated") return { state: "paid" };
      throw ApiError.conflict("We received your payment and it needs a quick review. We'll email you shortly.");
    }
  }

  // A failed or lapsed attempt starts a fresh order under the same registration.
  const startNewAttempt = async (): Promise<void> => {
    const current = Number(pay.attempt ?? 1);
    const orderId = `${registrationId}_a${current + 1}`;
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(paymentRef(db, registrationId));
      if (Number(fresh.data()?.attempt ?? 1) !== current) return; // someone else already did
      tx.update(fresh.ref, { attempt: current + 1, orderId, orderIds: FieldValue.arrayUnion(orderId), status: "created", failureReason: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
      tx.update(regRef, { paymentStatus: "pending", updatedAt: FieldValue.serverTimestamp() });
    });
    pay = (await paymentRef(db, registrationId).get()).data()!;
  };
  if (pay.status === "failed") await startNewAttempt();

  const member = ((reg.members ?? []) as Array<{ phone?: string }>)[0];
  const phone = cleanPhone(member?.phone);
  const expiresAt = millis(reg.holdExpiresAt);
  const create = (orderId: string) =>
    adapter.createOrder(ctx, {
      orderId,
      amountPaise: Number(pay.amountPaise),
      currency: "INR",
      customer: { id: userId, name: String(reg.userName ?? ""), email: String(reg.userEmail ?? ""), ...(phone ? { phone } : {}) },
      returnUrl: `${appUrl()}/registered/${registrationId}?payment=return`,
      notifyUrl: `${appUrl()}/api/payments/webhook/${account.provider}`,
      expiresAt: new Date(expiresAt),
    });

  let checkout: CheckoutSession;
  try {
    checkout = await create(String(pay.orderId));
  } catch (error) {
    if (!(error instanceof OrderTerminalError)) {
      console.warn("[payments] createOrder failed", JSON.stringify({ registrationId, message: error instanceof Error ? error.message : "unknown" }));
      throw new ApiError(502, "payment-provider-error", "We couldn't reach the payment provider. Your seat is still held — please try again in a moment.");
    }
    // The previous order ended (failed or expired at the provider): look at what actually happened, then start over.
    const snapshot = await adapter.fetchOrder(ctx, String(pay.orderId)).catch(() => null);
    if (snapshot?.status === "paid") {
      const outcome = await applyOrderSnapshot(registrationId, snapshot);
      if (outcome.kind === "confirmed" || outcome.kind === "reinstated") return { state: "paid" };
      throw ApiError.conflict("We received your payment and it needs a quick review. We'll email you shortly.");
    }
    await startNewAttempt();
    checkout = await create(String(pay.orderId)).catch(() => {
      throw new ApiError(502, "payment-provider-error", "We couldn't reach the payment provider. Your seat is still held — please try again in a moment.");
    });
  }

  // Never overwrite a payment that was confirmed while the order was being created.
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(paymentRef(db, registrationId));
    const status = fresh.data()?.status;
    tx.update(fresh.ref, { providerOrderId: checkout.providerOrderId, ...(status === "created" ? { status: "pending" } : {}), updatedAt: FieldValue.serverTimestamp() });
  });
  return { state: "checkout", checkout, orderId: String(pay.orderId), amountPaise: Number(pay.amountPaise), expiresAt };
};
