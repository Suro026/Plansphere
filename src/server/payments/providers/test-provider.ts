import { createHmac, timingSafeEqual } from "node:crypto";
import {
  OrderTerminalError,
  type CheckoutSession,
  type CreateOrderInput,
  type CredentialCheck,
  type OrderSnapshot,
  type PaymentProviderAdapter,
  type ProviderContext,
  type ProviderOrderStatus,
  type RefundInput,
  type RefundLookup,
  type RefundResult,
  type WebhookEvent,
} from "./types";

/**
 * An in-process fake gateway for development and automated tests.
 *
 * It exists so the registration/payment lifecycle can be exercised end to end —
 * checkout, signed webhooks, verification, refunds — without any real provider,
 * credential or charge. It moves no money and talks to no network.
 *
 * It is registered only when `testProviderAllowed()` (never when NODE_ENV is
 * "production"), so it cannot be selected or reached in a deployed build.
 *
 * Webhooks are signed the way most gateways sign them: HMAC-SHA256 of the raw
 * body with the merchant's webhook secret, hex in `x-test-signature`.
 */

interface FakeOrder {
  orderId: string;
  amountPaise: number;
  currency: string;
  status: ProviderOrderStatus;
  paymentId?: string;
  failureReason?: string;
  refunds: Map<string, { amountPaise: number; status: "success" | "pending" | "failed" }>;
}

const orders = new Map<string, FakeOrder>();
let down = false;
let failWith: string | null = null;
let redirectOverride: string | null = null;
let nextRefund: "success" | "pending" | "failed" = "success";

/** Test-only handles. Never called from application code. */
export const testProviderControl = {
  reset(): void {
    orders.clear();
    down = false;
    failWith = null;
    redirectOverride = null;
    nextRefund = "success";
  },
  /** What the provider says happened to a refund it already holds (pending → success, say). */
  settleRefund(orderId: string, refundId: string, status: "success" | "pending" | "failed"): void {
    const refund = orders.get(orderId)?.refunds.get(refundId);
    if (!refund) throw new Error(`test provider has no refund ${refundId} on ${orderId}`);
    refund.status = status;
  },
  /** Make a refund the provider holds report a different amount than was asked for. */
  setRefundAmount(orderId: string, refundId: string, amountPaise: number): void {
    const refund = orders.get(orderId)?.refunds.get(refundId);
    if (!refund) throw new Error(`test provider has no refund ${refundId} on ${orderId}`);
    refund.amountPaise = amountPaise;
  },
  /** Make the next checkouts return this redirect address instead of the real one (to prove bad addresses are refused). */
  setRedirectUrl(url: string | null): void {
    redirectOverride = url;
  },
  /** Make every call throw this message (to prove errors are scrubbed of credentials before they are logged). */
  failWith(message: string | null): void {
    failWith = message;
  },
  /** Simulate the provider being unreachable (fetchOrder / createOrder / refund throw). */
  setDown(value: boolean): void {
    down = value;
  },
  /** What the next refund call answers. */
  setNextRefund(status: "success" | "pending" | "failed"): void {
    nextRefund = status;
  },
  /** The provider-side outcome of an order, as if the customer had paid / failed / let it lapse. */
  settle(orderId: string, status: ProviderOrderStatus, extra: { paymentId?: string; amountPaise?: number; currency?: string; failureReason?: string } = {}): void {
    const order = orders.get(orderId);
    if (!order) throw new Error(`test provider has no order ${orderId}`);
    order.status = status;
    if (status === "paid") order.paymentId = extra.paymentId ?? `pay_${orderId}`;
    if (extra.amountPaise !== undefined) order.amountPaise = extra.amountPaise;
    if (extra.currency !== undefined) order.currency = extra.currency;
    if (extra.failureReason) order.failureReason = extra.failureReason;
  },
  order(orderId: string): FakeOrder | undefined {
    return orders.get(orderId);
  },
  /** A webhook body and its valid signature header, for the merchant's webhook secret. */
  signedWebhook(body: Record<string, unknown>, webhookSecret: string): { raw: string; headers: Record<string, string> } {
    const raw = JSON.stringify(body);
    return { raw, headers: { "x-test-signature": sign(raw, webhookSecret) } };
  },
  sign: (raw: string, secret: string): string => sign(raw, secret),
};

const sign = (raw: string, secret: string): string => createHmac("sha256", secret).update(raw).digest("hex");

const reachable = () => {
  if (failWith) throw new Error(failWith);
  if (down) throw new Error("test provider is unreachable");
};

export const testProvider: PaymentProviderAdapter = {
  id: "test",
  label: "Test provider (development only)",
  modes: ["sandbox"],
  credentialFields: [
    { key: "webhookSecret", label: "Webhook secret", secret: true },
    // Lets tests stand in for "a different merchant account": the test provider reports whatever is given here.
    { key: "merchantId", label: "Merchant id", secret: false, optional: true },
  ],
  checkoutHosts: ["test-provider.invalid"],

  async verifyCredentials(ctx: ProviderContext): Promise<CredentialCheck> {
    reachable();
    const secret = ctx.credentials.webhookSecret ?? "";
    if (secret.length < 8) return { ok: false, reason: "The webhook secret is too short to be real." };
    const id = (ctx.credentials.merchantId ?? "").trim() || "test-merchant";
    return { ok: true, merchantId: id, merchantName: `Test merchant (${id})` };
  },

  async createOrder(_ctx: ProviderContext, input: CreateOrderInput): Promise<CheckoutSession> {
    reachable();
    const existing = orders.get(input.orderId);
    if (existing) {
      if (existing.status !== "pending") throw new OrderTerminalError();
    } else {
      orders.set(input.orderId, { orderId: input.orderId, amountPaise: input.amountPaise, currency: input.currency, status: "pending", refunds: new Map() });
    }
    return { providerOrderId: `test_${input.orderId}`, redirectUrl: redirectOverride ?? `https://test-provider.invalid/pay/${encodeURIComponent(input.orderId)}` };
  },

  async fetchOrder(_ctx: ProviderContext, orderId: string): Promise<OrderSnapshot> {
    reachable();
    const order = orders.get(orderId);
    if (!order) return { orderId, status: "failed", amountPaise: 0, currency: "INR", failureReason: "unknown order" };
    return {
      orderId,
      providerOrderId: `test_${orderId}`,
      status: order.status,
      amountPaise: order.amountPaise,
      currency: order.currency,
      ...(order.paymentId ? { providerPaymentId: order.paymentId } : {}),
      ...(order.failureReason ? { failureReason: order.failureReason } : {}),
    };
  },

  peekWebhook(rawBody: string): { orderId: string } | null {
    try {
      const body = JSON.parse(rawBody) as { orderId?: unknown };
      return typeof body.orderId === "string" && body.orderId ? { orderId: body.orderId } : null;
    } catch {
      return null;
    }
  },

  verifyWebhook(ctx: ProviderContext, rawBody: string, headers: Headers): WebhookEvent | null {
    const secret = ctx.credentials.webhookSecret;
    const given = headers.get("x-test-signature");
    if (!secret || !given) return null;
    const expected = sign(rawBody, secret);
    const a = Buffer.from(given, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const body = JSON.parse(rawBody) as { eventId?: unknown; type?: unknown; orderId?: unknown; refundId?: unknown; status?: unknown; amountPaise?: unknown };
      if (typeof body.eventId !== "string" || typeof body.orderId !== "string") return null;
      if (body.type === "payment") return { kind: "payment", eventId: body.eventId, orderId: body.orderId };
      if (body.type === "refund" && typeof body.refundId === "string" && (body.status === "success" || body.status === "pending" || body.status === "failed")) {
        return {
          kind: "refund",
          eventId: body.eventId,
          orderId: body.orderId,
          refundId: body.refundId,
          status: body.status,
          ...(typeof body.amountPaise === "number" ? { amountPaise: body.amountPaise } : {}),
        };
      }
      return null;
    } catch {
      return null;
    }
  },

  async refund(_ctx: ProviderContext, input: RefundInput): Promise<RefundResult> {
    reachable();
    const order = orders.get(input.orderId);
    if (!order || order.status !== "paid") return { status: "failed", message: "order is not paid" };
    // Idempotent per refund id, whatever happened the first time: asking again returns that refund as it is now.
    const prior = order.refunds.get(input.refundId);
    if (prior) return { status: prior.status, providerRefundId: `rf_${input.refundId}`, amountPaise: prior.amountPaise };
    order.refunds.set(input.refundId, { amountPaise: input.amountPaise, status: nextRefund });
    return { status: nextRefund, providerRefundId: `rf_${input.refundId}`, amountPaise: input.amountPaise };
  },

  async fetchRefund(_ctx: ProviderContext, input: { orderId: string; refundId: string }): Promise<RefundLookup> {
    reachable();
    const found = orders.get(input.orderId)?.refunds.get(input.refundId);
    return found ? { status: found.status, providerRefundId: `rf_${input.refundId}`, amountPaise: found.amountPaise } : { status: "not_found" };
  },
};
