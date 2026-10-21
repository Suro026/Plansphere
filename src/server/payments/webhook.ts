import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { bindingProblem, loadAccount, providerContextFor } from "./account";
import { applyOrderSnapshot, flagBindingProblem, paymentRef, recordRefundOutcome, refundRecordIdOf } from "./lifecycle";
import { getAdapter } from "./providers/registry";
import { Timestamp } from "@/server/firebase-admin";

export interface WebhookResult {
  kind: "applied" | "duplicate" | "ignored" | "rejected" | "retry" | "held";
  status: number;
}

const log = (event: string, fields: Record<string, unknown>) => console.info("[payments]", JSON.stringify({ event, ...fields }));

/** `abc123` and `abc123_a2` both belong to registration `abc123`. */
const registrationOf = (orderId: string): string => orderId.replace(/_a\d+$/, "");

/**
 * Handles one provider webhook. The rules, in order:
 *
 *  1. Find whose credentials could have signed it (from the order id it
 *     names). A body that names nothing we know is acknowledged and dropped.
 *  2. Verify the signature against **that merchant's** secret. No signature,
 *     no action — and nothing about the payment is revealed.
 *  3. Record the event id in a ledger so a provider's retries are recognised.
 *  4. Never trust the body: re-read the order from the provider and apply
 *     *that* (`applyOrderSnapshot` also checks amount, currency and order).
 *
 * Every step downstream is idempotent, so a duplicate, a delayed or an
 * out-of-order delivery converges on the same state.
 */
export const processWebhook = async (providerId: string, rawBody: string, headers: Headers): Promise<WebhookResult> => {
  const adapter = getAdapter(providerId);
  if (!adapter) return { kind: "rejected", status: 404 };

  const peek = adapter.peekWebhook(rawBody);
  if (!peek) return { kind: "rejected", status: 400 };

  const db = adminDb();
  const registrationId = registrationOf(peek.orderId);
  const paySnap = await paymentRef(db, registrationId).get();
  const pay = paySnap.data();
  if (!pay || pay.provider !== providerId || !((pay.orderIds ?? [pay.orderId]) as string[]).includes(peek.orderId)) {
    log("webhook_unknown_order", { provider: providerId });
    return { kind: "ignored", status: 200 };
  }

  const account = await loadAccount(String(pay.festId));
  if (!account) return { kind: "ignored", status: 200 };

  let context;
  try {
    context = await providerContextFor(account);
  } catch {
    // Our configuration problem, not the sender's: ask them to try again later.
    return { kind: "retry", status: 503 };
  }

  const event = adapter.verifyWebhook(context.ctx, rawBody, headers);
  if (!event || event.orderId !== peek.orderId) {
    log("webhook_bad_signature", { provider: providerId, registrationId });
    return { kind: "rejected", status: 401 };
  }

  // Signed by the credentials now on file, but the payment was made under another merchant account:
  // acknowledge it (so the provider stops retrying), hold it for a person, and touch nothing.
  const problem = bindingProblem(pay, account);
  if (problem) {
    await flagBindingProblem(registrationId, problem);
    return { kind: "held", status: 200 };
  }

  // Ledger: has this exact delivery been fully handled already?
  const ledger = db.collection(COLLECTIONS.paymentEvents).doc(`${providerId}_${event.eventId}`.replace(/[/\s]/g, "_").slice(0, 200));
  const seen = await ledger.get();
  if (seen.exists && seen.data()?.state === "done") return { kind: "duplicate", status: 200 };
  await ledger.set(
    { provider: providerId, eventId: event.eventId, kind: event.kind, orderId: event.orderId, registrationId, festId: String(pay.festId), state: "processing", receivedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  try {
    let outcome = "";
    if (event.kind === "payment") {
      const snapshot = await context.adapter.fetchOrder(context.ctx, event.orderId);
      outcome = (await applyOrderSnapshot(registrationId, snapshot)).kind;
    } else {
      // A refund webhook is only a hint. The refund is read back from the provider, and that is what is recorded.
      const lookup = await context.adapter.fetchRefund(context.ctx, { orderId: event.orderId, refundId: event.refundId });
      const recordId = refundRecordIdOf(event.refundId);
      if (lookup.status === "not_found") {
        outcome = "refund_unknown";
      } else {
        const record = ((pay.refunds ?? []) as Array<{ id: string; amountPaise: number }>).find((r) => r.id === recordId);
        if (record && lookup.amountPaise !== undefined && lookup.amountPaise !== record.amountPaise) {
          await paymentRef(db, registrationId).update({
            flags: FieldValue.arrayUnion("refund_amount_mismatch"),
            anomalies: FieldValue.arrayUnion({ type: "refund_amount_mismatch", refundId: event.refundId, amountPaise: lookup.amountPaise, at: Timestamp.now() }),
          });
        }
        await recordRefundOutcome(registrationId, recordId, lookup);
        outcome = `refund_${lookup.status}`;
      }
    }
    await ledger.set({ state: "done", outcome, processedAt: FieldValue.serverTimestamp() }, { merge: true });
    log("webhook_processed", { provider: providerId, registrationId, kind: event.kind, outcome });
    return { kind: "applied", status: 200 };
  } catch (error) {
    // Leave the ledger entry at "processing": the provider's retry will pick it up.
    log("webhook_failed", { provider: providerId, registrationId, message: error instanceof Error ? error.message : "unknown" });
    return { kind: "retry", status: 503 };
  }
};
