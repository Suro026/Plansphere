// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAYMENT_MIN_PAISE, entryAmountPaise, eventRequiresPayment, formatRupees } from "@/core/models/payment";
import { holdsSeat, occupiesSeat } from "@/core/models/registration";
import { decryptCredentials, encryptCredentials, PaymentConfigError } from "@/server/payments/secrets";
import { testProvider, testProviderControl } from "@/server/payments/providers/test-provider";
import { availableProviders, getAdapter } from "@/server/payments/providers/registry";
import { holdMinutes, livePaymentsEnabled, paymentsEnabled, testProviderAllowed } from "@/server/payments/config";
import { orderingBlocker } from "@/server/payments/account";

const ENV = ["PAYMENTS_ENABLED", "PAYMENTS_LIVE_ENABLED", "PAYMENTS_ALLOW_TEST_PROVIDER", "PAYMENT_SECRET_KEY", "PAYMENT_HOLD_MINUTES"] as const;
const saved: Record<string, string | undefined> = {};
const nodeEnv = process.env.NODE_ENV;
const setNodeEnv = (value: string | undefined) => {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
};

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setNodeEnv(nodeEnv);
});

describe("which events take online payment", () => {
  it("only when the switch is on and the fee is a real amount", () => {
    expect(eventRequiresPayment({ entryFee: 500, paymentEnabled: true })).toBe(true);
    expect(eventRequiresPayment({ entryFee: 500, paymentEnabled: false })).toBe(false);
    // Today's events: a fee is information, not a charge.
    expect(eventRequiresPayment({ entryFee: 500 })).toBe(false);
    expect(eventRequiresPayment({ paymentEnabled: true })).toBe(false);
    expect(eventRequiresPayment({ entryFee: 0, paymentEnabled: true })).toBe(false);
    expect(PAYMENT_MIN_PAISE).toBe(100);
  });

  it("derives the amount in integer paise from the event alone", () => {
    expect(entryAmountPaise({ entryFee: 500 })).toBe(50000);
    expect(entryAmountPaise({ entryFee: 1 })).toBe(100);
    expect(entryAmountPaise({})).toBe(0);
    expect(formatRupees(50000)).toBe("₹500");
    expect(formatRupees(50050)).toBe("₹500.50");
  });
});

describe("seat accounting", () => {
  it("an unpaid hold takes capacity but never counts as a registration", () => {
    expect(occupiesSeat("pending_payment")).toBe(true);
    // Analytics and certificates read holdsSeat; unpaid entries must stay out of both.
    expect(holdsSeat("pending_payment")).toBe(false);
    expect(holdsSeat("confirmed")).toBe(true);
    expect(occupiesSeat("waitlisted")).toBe(false);
    expect(occupiesSeat("cancelled")).toBe(false);
  });
});

describe("platform switches", () => {
  it("are all off by default", () => {
    expect(paymentsEnabled()).toBe(false);
    expect(livePaymentsEnabled()).toBe(false);
    expect(testProviderAllowed()).toBe(false);
    expect(availableProviders()).toEqual([]);
    expect(getAdapter("test")).toBeNull();
  });

  it("the test provider can never exist in production", () => {
    process.env.PAYMENTS_ALLOW_TEST_PROVIDER = "1";
    setNodeEnv("test");
    expect(getAdapter("test")).toBe(testProvider);
    setNodeEnv("production");
    expect(testProviderAllowed()).toBe(false);
    expect(getAdapter("test")).toBeNull();
    expect(availableProviders()).toEqual([]);
  });

  it("no real gateway is registered", () => {
    process.env.PAYMENTS_ALLOW_TEST_PROVIDER = "1";
    for (const id of ["cashfree", "phonepe", "payu", "razorpay", "stripe"]) expect(getAdapter(id)).toBeNull();
  });

  it("an account is usable only through every switch", () => {
    process.env.PAYMENTS_ALLOW_TEST_PROVIDER = "1";
    const account = { festId: "f", provider: "test", mode: "sandbox" as const, status: "active" as const };
    expect(orderingBlocker(account)).toMatch(/not enabled/);
    process.env.PAYMENTS_ENABLED = "1";
    expect(orderingBlocker(account)).toBeNull();
    expect(orderingBlocker({ ...account, status: "pending_review" })).toMatch(/approved/);
    expect(orderingBlocker({ ...account, status: "suspended" })).toMatch(/approved/);
    expect(orderingBlocker(null)).toMatch(/approved/);
    expect(orderingBlocker({ ...account, mode: "live" })).toMatch(/Live payments/);
    process.env.PAYMENTS_LIVE_ENABLED = "1";
    expect(orderingBlocker({ ...account, mode: "live" })).toBeNull();
    expect(orderingBlocker({ ...account, provider: "cashfree" })).toMatch(/not available/);
  });

  it("clamps the hold length", () => {
    expect(holdMinutes()).toBe(15);
    process.env.PAYMENT_HOLD_MINUTES = "1";
    expect(holdMinutes()).toBe(5);
    process.env.PAYMENT_HOLD_MINUTES = "9999";
    expect(holdMinutes()).toBe(60);
    process.env.PAYMENT_HOLD_MINUTES = "nonsense";
    expect(holdMinutes()).toBe(15);
  });
});

describe("credential encryption", () => {
  const key = Buffer.alloc(32, 9).toString("base64");

  it("round-trips, and the ciphertext contains no plaintext", () => {
    process.env.PAYMENT_SECRET_KEY = key;
    const blob = encryptCredentials({ webhookSecret: "super-secret-value" }, "fest1");
    expect(JSON.stringify(blob)).not.toContain("super-secret-value");
    expect(decryptCredentials(blob, "fest1")).toEqual({ webhookSecret: "super-secret-value" });
    // A fresh IV every time.
    expect(encryptCredentials({ a: "b" }, "fest1").iv).not.toBe(encryptCredentials({ a: "b" }, "fest1").iv);
  });

  it("will not decrypt for another fest, with another key, or after tampering", () => {
    process.env.PAYMENT_SECRET_KEY = key;
    const blob = encryptCredentials({ k: "v" }, "fest1");
    expect(() => decryptCredentials(blob, "fest2")).toThrow(PaymentConfigError);
    expect(() => decryptCredentials({ ...blob, data: Buffer.from("tampered").toString("base64") }, "fest1")).toThrow(PaymentConfigError);
    process.env.PAYMENT_SECRET_KEY = Buffer.alloc(32, 1).toString("base64");
    expect(() => decryptCredentials(blob, "fest1")).toThrow(PaymentConfigError);
  });

  it("refuses to run without a proper key", () => {
    expect(() => encryptCredentials({ k: "v" }, "fest1")).toThrow(/not set/);
    process.env.PAYMENT_SECRET_KEY = Buffer.alloc(16).toString("base64");
    expect(() => encryptCredentials({ k: "v" }, "fest1")).toThrow(/32 bytes/);
  });
});

describe("the test provider", () => {
  const ctx = { mode: "sandbox" as const, credentials: { webhookSecret: "whsec" } };
  const order = { orderId: "o1", amountPaise: 1000, currency: "INR" as const, customer: { id: "u", name: "N", email: "n@x.test" }, returnUrl: "r", notifyUrl: "n", expiresAt: new Date() };

  beforeEach(() => testProviderControl.reset());

  it("verifies only a body signed with the merchant secret", () => {
    const { raw, headers } = testProviderControl.signedWebhook({ eventId: "e1", type: "payment", orderId: "o1" }, "whsec");
    expect(testProvider.verifyWebhook(ctx, raw, new Headers(headers))).toEqual({ kind: "payment", eventId: "e1", orderId: "o1" });
    expect(testProvider.verifyWebhook(ctx, raw, new Headers())).toBeNull();
    expect(testProvider.verifyWebhook(ctx, raw, new Headers({ "x-test-signature": "00".repeat(32) }))).toBeNull();
    // Any change to the body breaks the signature.
    expect(testProvider.verifyWebhook(ctx, raw + " ", new Headers(headers))).toBeNull();
    expect(testProvider.verifyWebhook({ ...ctx, credentials: { webhookSecret: "other" } }, raw, new Headers(headers))).toBeNull();
    expect(testProvider.verifyWebhook({ ...ctx, credentials: {} }, raw, new Headers(headers))).toBeNull();
  });

  it("never throws on junk", () => {
    expect(testProvider.peekWebhook("not json")).toBeNull();
    expect(testProvider.peekWebhook("{}")).toBeNull();
    expect(testProvider.verifyWebhook(ctx, "not json", new Headers({ "x-test-signature": "ab" }))).toBeNull();
  });

  it("creates orders idempotently and refuses to reopen a finished one", async () => {
    const first = await testProvider.createOrder(ctx, order);
    expect(await testProvider.createOrder(ctx, order)).toEqual(first);
    testProviderControl.settle("o1", "paid");
    await expect(testProvider.createOrder(ctx, order)).rejects.toThrow(/no longer be paid/);
  });

  it("refunds a paid order once per refund id", async () => {
    await testProvider.createOrder(ctx, order);
    expect((await testProvider.refund(ctx, { orderId: "o1", refundId: "r1", amountPaise: 1000 })).status).toBe("failed");
    testProviderControl.settle("o1", "paid");
    expect((await testProvider.refund(ctx, { orderId: "o1", refundId: "r1", amountPaise: 1000 })).status).toBe("success");
    expect((await testProvider.refund(ctx, { orderId: "o1", refundId: "r1", amountPaise: 1000 })).status).toBe("success");
    expect(testProviderControl.order("o1")!.refunds.size).toBe(1);
  });
});
