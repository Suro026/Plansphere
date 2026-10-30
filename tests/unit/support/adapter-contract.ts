import { describe, expect, it } from "vitest";
import { isAllowedRedirect, redactSecrets } from "@/server/payments/providers/safe";
import type { PaymentMode } from "@/core/models/payment";
import type { PaymentProviderAdapter, ProviderContext, WebhookEvent } from "@/server/payments/providers/types";

/**
 * The behaviours every payment adapter must have before the lifecycle will
 * trust it. The test provider runs this today (`tests/unit/payment-adapter-contract.test.ts`);
 * a real adapter adds one call with a harness that talks to *that provider's
 * sandbox* — never live — and it must pass before the adapter is registered.
 *
 * It states what the lifecycle relies on; it does not assume any provider can
 * do these things. An adapter that cannot meet a clause has to say so and the
 * lifecycle has to be changed deliberately, not skipped here.
 */

export interface ContractHarness {
  name: string;
  adapter: PaymentProviderAdapter;
  mode: PaymentMode;
  goodCredentials: Record<string, string>;
  badCredentials: Record<string, string>;
  /** Start from a clean provider (sandbox) state. */
  reset(): void;
  /** Make the customer pay this order at the provider, in full. */
  pay(orderId: string): void;
  /** A webhook body and the headers that make it valid for `goodCredentials`. */
  signedWebhook(body: Record<string, unknown>): { raw: string; headers: Record<string, string> };
}

const order = (orderId: string, amountPaise = 25000) => ({
  orderId,
  amountPaise,
  currency: "INR" as const,
  customer: { id: "u1", name: "Contract Tester", email: "tester@example.test" },
  returnUrl: "https://app.example.test/return",
  notifyUrl: "https://app.example.test/hook",
  expiresAt: new Date(Date.now() + 15 * 60_000),
});

export const adapterContract = (h: ContractHarness): void => {
  const ctx: ProviderContext = { mode: h.mode, credentials: h.goodCredentials };

  describe(`payment adapter contract — ${h.name}`, () => {
    it("declares what it is: modes, credential fields and the hosts its checkout may live on", () => {
      expect(h.adapter.id).toBeTruthy();
      expect(h.adapter.modes.length).toBeGreaterThan(0);
      expect(h.adapter.credentialFields.length).toBeGreaterThan(0);
      for (const host of h.adapter.checkoutHosts) expect(host, host).toMatch(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i);
      // Secret fields must be marked, so the settings screen can keep them write-only.
      expect(h.adapter.credentialFields.some((f) => f.secret)).toBe(true);
    });

    it("verifyCredentials reports the provider's own merchant identity, and answers (never throws) for bad credentials", async () => {
      h.reset();
      const good = await h.adapter.verifyCredentials(ctx);
      expect(good.ok).toBe(true);
      if (good.ok) {
        expect(good.merchantId.length).toBeGreaterThan(0);
        expect(good.merchantName.length).toBeGreaterThan(0);
      }
      const bad = await h.adapter.verifyCredentials({ mode: h.mode, credentials: h.badCredentials });
      expect(bad.ok).toBe(false);
      if (!bad.ok) {
        expect(typeof bad.reason).toBe("string");
        for (const value of Object.values(h.badCredentials).filter((v) => v.length >= 4)) expect(bad.reason).not.toContain(value);
      }
    });

    it("createOrder is idempotent per order id and only ever returns an allowed https checkout host", async () => {
      h.reset();
      const first = await h.adapter.createOrder(ctx, order("c-order-1"));
      const again = await h.adapter.createOrder(ctx, order("c-order-1"));
      expect(again).toEqual(first);
      if (first.redirectUrl !== undefined) expect(isAllowedRedirect(first.redirectUrl, h.adapter.checkoutHosts), first.redirectUrl).toBe(true);
    });

    it("fetchOrder is the source of truth: pending until paid, then paid with the exact amount and currency", async () => {
      h.reset();
      await h.adapter.createOrder(ctx, order("c-order-2", 31000));
      const before = await h.adapter.fetchOrder(ctx, "c-order-2");
      expect(before.status).toBe("pending");
      h.pay("c-order-2");
      const after = await h.adapter.fetchOrder(ctx, "c-order-2");
      expect(after).toMatchObject({ orderId: "c-order-2", status: "paid", amountPaise: 31000, currency: "INR" });
    });

    it("refunds are idempotent per refund id: the same id again resolves to the same refund, never a second one", async () => {
      h.reset();
      await h.adapter.createOrder(ctx, order("c-order-3", 40000));
      h.pay("c-order-3");

      expect(await h.adapter.fetchRefund(ctx, { orderId: "c-order-3", refundId: "r-1" })).toEqual({ status: "not_found" });

      const first = await h.adapter.refund(ctx, { orderId: "c-order-3", refundId: "r-1", amountPaise: 40000 });
      expect(["success", "pending"]).toContain(first.status);
      const again = await h.adapter.refund(ctx, { orderId: "c-order-3", refundId: "r-1", amountPaise: 40000 });
      expect(again.status).toBe(first.status);
      expect(again.providerRefundId).toBe(first.providerRefundId);

      const read = await h.adapter.fetchRefund(ctx, { orderId: "c-order-3", refundId: "r-1" });
      expect(read.status).toBe(first.status);
      if (read.status !== "not_found" && read.amountPaise !== undefined) expect(read.amountPaise).toBe(40000);
    });

    it("never refunds an order that was not paid", async () => {
      h.reset();
      await h.adapter.createOrder(ctx, order("c-order-4"));
      const result = await h.adapter.refund(ctx, { orderId: "c-order-4", refundId: "r-x", amountPaise: 25000 });
      expect(result.status).toBe("failed");
      const read = await h.adapter.fetchRefund(ctx, { orderId: "c-order-4", refundId: "r-x" });
      expect(read.status === "not_found" || read.status === "failed").toBe(true);
    });

    it("accepts only webhooks signed for these credentials, and never throws on garbage", () => {
      const payment = h.signedWebhook({ eventId: "e-1", type: "payment", orderId: "c-order-9" });
      const event = h.adapter.verifyWebhook(ctx, payment.raw, new Headers(payment.headers)) as WebhookEvent | null;
      expect(event).toMatchObject({ kind: "payment", orderId: "c-order-9" });
      expect(h.adapter.peekWebhook(payment.raw)).toEqual({ orderId: "c-order-9" });

      expect(h.adapter.verifyWebhook(ctx, payment.raw, new Headers())).toBeNull();
      expect(h.adapter.verifyWebhook(ctx, `${payment.raw} `, new Headers(payment.headers))).toBeNull();
      expect(h.adapter.verifyWebhook({ mode: h.mode, credentials: h.badCredentials }, payment.raw, new Headers(payment.headers))).toBeNull();
      for (const junk of ["", "not json", "[]", "null", '{"orderId":5}', "{".repeat(1000)]) {
        expect(() => h.adapter.verifyWebhook(ctx, junk, new Headers(payment.headers))).not.toThrow();
        expect(() => h.adapter.peekWebhook(junk)).not.toThrow();
      }
    });

    it("error messages that reach the app never contain the credentials", () => {
      // The wrapper in providers/safe.ts is what guarantees this for real adapters; this pins its behaviour on
      // this adapter's own credential values.
      const secrets = Object.values(h.goodCredentials).filter((v) => v.length >= 4);
      const leaky = `HTTP 401 for ${secrets.map((s) => `key=${s}`).join(" ")} Authorization: Bearer ${secrets[0] ?? "x"}`;
      const cleaned = redactSecrets(leaky, h.goodCredentials);
      for (const secret of secrets) expect(cleaned).not.toContain(secret);
    });
  });
};
