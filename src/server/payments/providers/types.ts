import type { PaymentMode, PaymentProviderId } from "@/core/models/payment";

/**
 * What the registration/payment lifecycle needs from a gateway, and nothing
 * more. The lifecycle (`../lifecycle.ts`) never imports a provider; it talks to
 * whatever adapter the registry returns, so adding a gateway is adding one file.
 *
 * Contract every adapter must keep:
 *   - `createOrder` is idempotent per `orderId`: calling it again for an order
 *     that is still payable returns the same checkout; for an order that has
 *     reached a terminal state it throws `OrderTerminalError`.
 *   - `fetchOrder` is the source of truth. A webhook only says "look at this
 *     order"; the lifecycle re-reads it here before believing anything.
 *   - `verifyWebhook` returns null unless the signature checks out against the
 *     merchant's own credentials, and never throws on bad input.
 *   - Nothing here logs or returns credentials.
 *
 * The contract is enforced, not just documented:
 *   - `tests/unit/support/adapter-contract.ts` is a reusable suite every adapter
 *     must pass (the test provider runs it today; a real adapter adds one line).
 *   - `providers/safe.ts` wraps every adapter before the lifecycle sees it:
 *     errors are stripped of credentials, and a checkout URL is refused unless
 *     it is https on one of the adapter's declared hosts.
 *
 * Nothing below names or assumes a particular gateway. What a real provider
 * can do (credential check endpoint, refund lookup, idempotency keys) has to be
 * confirmed from that provider's own documentation before its adapter is
 * written; an adapter that cannot meet a clause must say so, not fake it.
 */

export type PaymentCredentials = Record<string, string>;

export interface ProviderContext {
  mode: PaymentMode;
  credentials: PaymentCredentials;
}

export interface CreateOrderInput {
  /** Unique per order; the lifecycle derives it from the registration id. */
  orderId: string;
  amountPaise: number;
  currency: "INR";
  customer: { id: string; name: string; email: string; phone?: string };
  /** Where the customer lands after checkout. Never trusted as proof of payment. */
  returnUrl: string;
  /** Where the provider posts webhooks for this order. */
  notifyUrl: string;
  /** The order should not be payable after this moment (the end of the seat hold). */
  expiresAt: Date;
}

export interface CheckoutSession {
  providerOrderId: string;
  /** A hosted page to send the customer to. */
  redirectUrl?: string;
  /** Or a provider session token for its drop-in. */
  sessionId?: string;
}

export type ProviderOrderStatus = "pending" | "paid" | "failed" | "expired";

export interface OrderSnapshot {
  orderId: string;
  providerOrderId?: string;
  status: ProviderOrderStatus;
  amountPaise: number;
  currency: string;
  providerPaymentId?: string;
  failureReason?: string;
}

export type WebhookEvent =
  | { kind: "payment"; eventId: string; orderId: string }
  | { kind: "refund"; eventId: string; orderId: string; refundId: string; status: "success" | "pending" | "failed"; amountPaise?: number };

export interface RefundInput {
  orderId: string;
  /** Idempotent: the same id must never refund twice. */
  refundId: string;
  amountPaise: number;
}

export interface RefundResult {
  status: "success" | "pending" | "failed";
  providerRefundId?: string;
  /** The amount the provider actually refunded or queued, when it says. */
  amountPaise?: number;
  message?: string;
}

export class OrderTerminalError extends Error {
  constructor(message = "The order can no longer be paid.") {
    super(message);
    this.name = "OrderTerminalError";
  }
}

export interface CredentialField {
  key: string;
  label: string;
  /** Secret fields are write-only: accepted, encrypted, never returned. */
  secret: boolean;
  /** May be left out when saving. Everything else is required. */
  optional?: boolean;
}

/**
 * What the provider says about the credentials it was just handed.
 *
 * `merchantId` / `merchantName` are what the **provider** reports, never what
 * the organizer typed. They are shown to the approver and bound to every
 * payment, so a later credential change can be told apart from a rotation of
 * the same merchant's keys.
 */
export type CredentialCheck = { ok: true; merchantId: string; merchantName: string } | { ok: false; reason: string };

/** A refund as the provider knows it. `not_found` means the provider has never seen that refund id. */
export type RefundLookup = RefundResult | { status: "not_found" };

export interface PaymentProviderAdapter {
  id: PaymentProviderId;
  label: string;
  modes: readonly PaymentMode[];
  credentialFields: readonly CredentialField[];
  /**
   * Hostnames a checkout redirect may point at: exact (`pay.example.com`) or a
   * wildcard (`*.example.com`). https only. Empty means no redirect is ever
   * accepted (a drop-in `sessionId` flow needs none).
   */
  checkoutHosts: readonly string[];
  /**
   * Asks the provider who these credentials belong to. Must not throw for bad
   * credentials: answer `{ ok: false, reason }`, and the reason must not echo
   * any credential. Called when an organizer saves credentials.
   */
  verifyCredentials(ctx: ProviderContext): Promise<CredentialCheck>;
  createOrder(ctx: ProviderContext, input: CreateOrderInput): Promise<CheckoutSession>;
  fetchOrder(ctx: ProviderContext, orderId: string): Promise<OrderSnapshot>;
  /** The order id a webhook body claims to be about — used only to find whose credentials to verify with. */
  peekWebhook(rawBody: string): { orderId: string } | null;
  verifyWebhook(ctx: ProviderContext, rawBody: string, headers: Headers): WebhookEvent | null;
  /**
   * Requests a refund. **Idempotent per `refundId`**: asking again for a refund
   * id the provider already has must return that refund's current status, not
   * an error and not a second refund. (If the provider reports "already exists"
   * as an error, resolve it with its refund lookup.)
   */
  refund(ctx: ProviderContext, input: RefundInput): Promise<RefundResult>;
  /**
   * Reads one refund back from the provider: the source of truth for refund
   * state, the way `fetchOrder` is for payments. Webhooks are only a hint.
   */
  fetchRefund(ctx: ProviderContext, input: { orderId: string; refundId: string }): Promise<RefundLookup>;
}
