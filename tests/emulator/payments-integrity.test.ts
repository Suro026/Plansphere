import { createCipheriv, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminDb, COLLECTIONS, FieldValue, Timestamp } from "@/server/firebase-admin";
import { POST as register } from "@/app/api/registrations/route";
import { POST as cancel } from "@/app/api/registrations/[id]/cancel/route";
import { POST as startPayment } from "@/app/api/registrations/[id]/payment/route";
import { POST as webhook } from "@/app/api/payments/webhook/[provider]/route";
import { POST as refundRoute } from "@/app/api/admin/payments/[registrationId]/refund/route";
import { POST as keysRoute } from "@/app/api/admin/payments/keys/route";
import { GET as getPayments, PUT as putPayments, POST as reviewPayments } from "@/app/api/admin/fests/[id]/payments/route";
import { PATCH as updateEvent } from "@/app/api/admin/events/[id]/route";
import { assertSafeAccountChange } from "@/server/payments/account-change";
import { applyOrderSnapshot, executeRefund, expirePendingHolds, MAX_REFUND_ATTEMPTS, retryAutoRefunds } from "@/server/payments/lifecycle";
import { encryptCredentials } from "@/server/payments/secrets";
import { testProvider, testProviderControl } from "@/server/payments/providers/test-provider";
import { callRoute, eventDoc, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * The audit's Stage 1 hardening, end to end against the route handlers and the
 * Firestore emulator (test provider only; no real provider, credential or
 * charge):
 *
 *   H5  a settled payment cannot be disturbed by a later snapshot
 *   H7  a payment is bound to the merchant account it was made under
 *   the adapter contract as the lifecycle relies on it: refund lookup and
 *   idempotency, credential checks, scrubbed errors, validated checkout URLs,
 *   versioned credential encryption
 */

const SECRET = "whsec_unit_test_only";
const NEW_SECRET = "whsec_after_the_change_1";
const ENV_KEYS = ["PAYMENTS_ENABLED", "PAYMENTS_LIVE_ENABLED", "PAYMENTS_ALLOW_TEST_PROVIDER", "PAYMENT_SECRET_KEY", "PAYMENT_SECRET_KEYS_PREVIOUS", "CRON_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};

let a: TestUser;
let b: TestUser;
let admin: TestUser;
let otherAdmin: TestUser;
let superAdmin: TestUser;

const db = () => adminDb();
const regDoc = async (id: string) => (await db().collection(COLLECTIONS.registrations).doc(id).get()).data()!;
const payDoc = async (id: string) => (await db().collection(COLLECTIONS.payments).doc(id).get()).data()!;
const accountDoc = async () => (await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").get()).data()!;

const seedAccount = async (over: Record<string, unknown> = {}, secret = SECRET) => {
  await db().collection(COLLECTIONS.paymentSecrets).doc("fest1").set({ festId: "fest1", blob: encryptCredentials({ webhookSecret: secret, merchantId: "m-1" }, "fest1"), updatedAt: new Date() });
  await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").set({ festId: "fest1", provider: "test", mode: "sandbox", status: "active", credentialsVersion: 1, merchantId: "m-1", merchantName: "Test merchant (m-1)", updatedAt: new Date(), ...over });
};

const reg = (user: TestUser) => callRoute(register, { path: "/api/registrations", token: user.idToken, body: { eventId: "ev1", teamName: `${user.name} solo`, members: [{ name: user.name, email: user.email }] } });
const checkout = (user: TestUser, id: string) => callRoute(startPayment, { path: `/x/${id}/payment`, token: user.idToken, params: { id }, body: {} });
const cancelReg = (user: TestUser, id: string) => callRoute(cancel, { path: `/x/${id}/cancel`, token: user.idToken, params: { id }, body: {} });
let eventCounter = 0;
const send = (body: Record<string, unknown>, secret = SECRET) => {
  const full = { eventId: `evt_i_${(eventCounter += 1)}`, ...body };
  return callRoute(webhook, { path: "/api/payments/webhook/test", params: { provider: "test" }, body: full, headers: testProviderControl.signedWebhook(full, secret).headers });
};
const paymentWebhook = (orderId: string) => send({ type: "payment", orderId });

/** Register, open the checkout, let the customer pay at the provider, and let the webhook confirm it. */
const paidRegistration = async (user: TestUser) => {
  const created = await reg(user);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.registration.id as string;
  expect((await checkout(user, id)).status).toBe(200);
  testProviderControl.settle(id, "paid");
  expect((await paymentWebhook(id)).status).toBe(200);
  expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
  return id;
};

/** A second order for an already-registered person, as if a second tab or a retry had also been paid. */
const secondOrder = async (id: string, amountPaise: number, suffix = "_a2") => {
  const orderId = `${id}${suffix}`;
  await testProvider.createOrder({ mode: "sandbox", credentials: {} }, { orderId, amountPaise, currency: "INR", customer: { id: "u", name: "N", email: "n@x.test" }, returnUrl: "r", notifyUrl: "n", expiresAt: new Date(Date.now() + 60_000) });
  await db().collection(COLLECTIONS.payments).doc(id).update({ orderIds: FieldValue.arrayUnion(orderId) });
  return orderId;
};

/** The organizer saves new credentials and a super admin approves them. */
const changeMerchant = async (merchantId: string, secret = NEW_SECRET) => {
  const saved = await callRoute(putPayments, { method: "PUT", path: "/x", params: { id: "fest1" }, token: admin.idToken, body: { provider: "test", mode: "sandbox", credentials: { webhookSecret: secret, merchantId } } });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const approved = await callRoute(reviewPayments, { path: "/x", params: { id: "fest1" }, token: superAdmin.idToken, body: { action: "approve", expectedVersion: saved.body.account.credentialsVersion, confirmMerchantId: saved.body.account.merchantId } });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
};

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.PAYMENTS_ENABLED = "1";
  process.env.PAYMENTS_ALLOW_TEST_PROVIDER = "1";
  process.env.PAYMENT_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.CRON_SECRET = "cron-secret-for-tests";
  delete process.env.PAYMENTS_LIVE_ENABLED;
  delete process.env.PAYMENT_SECRET_KEYS_PREVIOUS;

  await resetAuth();
  a = await mintUser({ name: "Alice" });
  b = await mintUser({ name: "Bob" });
  admin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Fest Admin" });
  otherAdmin = await mintUser({ role: "admin", festIds: ["fest2"], name: "Other Admin" });
  superAdmin = await mintUser({ role: "super_admin", name: "Super" });
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(async () => {
  await resetFirestore();
  testProviderControl.reset();
  for (const u of [a, b]) await db().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, fullName: u.name, name: u.name, role: "student", emailVerified: true, student: { college: "T" }, createdAt: new Date(), updatedAt: new Date() });
  for (const u of [admin, otherAdmin, superAdmin]) {
    await db().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, name: u.name, role: u.role, festIds: u.role === "admin" ? (u === admin ? ["fest1"] : ["fest2"]) : [], profileCompleted: true, createdAt: new Date(), updatedAt: new Date() });
  }
  await seedFest({ ownerId: admin.uid });
  await seedFest({ id: "fest2", slug: "other", name: "Other fest", ownerId: otherAdmin.uid });
  await seedAccount();
  await seedEvent({ entryFee: 500, paymentEnabled: true });
});

/* ───────────── H5 — a settled payment cannot be disturbed ───────────── */

describe("H5: a payment that is already settled", () => {
  it("is not disturbed by a second order with a different amount — that order is refunded, the original is not", async () => {
    const id = await paidRegistration(a);
    const second = await secondOrder(id, 12300);
    testProviderControl.settle(second, "paid", { paymentId: "pay_second" });
    expect((await paymentWebhook(second)).status).toBe(200);

    expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    const pay = await payDoc(id);
    expect(pay).toMatchObject({ status: "paid", paidOrderId: id, amountPaise: 50000, openRefunds: false });
    expect(pay.flags).toEqual(expect.arrayContaining(["duplicate_payment", "duplicate_payment_amount_mismatch"]));
    expect(pay.refunds).toHaveLength(1);
    expect(pay.refunds[0]).toMatchObject({ orderId: second, amountPaise: 12300, reason: "duplicate_payment", status: "success" });
    // The provider refunded the second order for what it captured, and never touched the first.
    expect(testProviderControl.order(second)!.refunds.size).toBe(1);
    expect(testProviderControl.order(id)!.refunds.size).toBe(0);
  });

  it("is only flagged — never changed — when the original order is read back with a different amount or currency", async () => {
    const id = await paidRegistration(a);
    const before = await payDoc(id);

    testProviderControl.settle(id, "paid", { amountPaise: 100 });
    expect((await paymentWebhook(id)).status).toBe(200);
    testProviderControl.settle(id, "paid", { amountPaise: 50000, currency: "USD" });
    expect((await paymentWebhook(id)).status).toBe(200);

    const after = await payDoc(id);
    expect(after).toMatchObject({ status: "paid", paidOrderId: id, amountPaise: 50000 });
    expect(after.flags).toContain("settled_order_changed");
    expect(after.anomalies.map((x: { type: string }) => x.type)).toContain("settled_order_changed");
    expect(after.refunds).toEqual([]);
    expect(after.capturedAmountPaise).toBeUndefined();
    expect(after.paidAt).toEqual(before.paidAt);
    expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect(testProviderControl.order(id)!.refunds.size).toBe(0);
  });

  it("flags — without refunding — a second payment id on the settled order", async () => {
    const id = await paidRegistration(a);
    testProviderControl.settle(id, "paid", { paymentId: "pay_other" });
    await paymentWebhook(id);
    const pay = await payDoc(id);
    expect(pay.flags).toContain("second_payment_on_settled_order");
    expect(pay.refunds).toEqual([]);
    expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
  });

  it("treats a replay of the very same payment as a no-op", async () => {
    const id = await paidRegistration(a);
    const before = await payDoc(id);
    await paymentWebhook(id);
    await paymentWebhook(id);
    const after = await payDoc(id);
    expect(after.flags ?? []).toEqual(before.flags ?? []);
    expect(after.refunds).toEqual([]);
  });

  it("stays refunded after a refund, whatever the provider later says about the order", async () => {
    const id = await paidRegistration(a);
    await cancelReg(a, id);
    await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: admin.idToken, body: { action: "approve" } });
    expect(await payDoc(id)).toMatchObject({ status: "refunded" });

    testProviderControl.settle(id, "paid", { amountPaise: 1 });
    await paymentWebhook(id);
    expect(await payDoc(id)).toMatchObject({ status: "refunded" });
    expect(await regDoc(id)).toMatchObject({ status: "cancelled", paymentStatus: "refunded" });
  });

  it("never refunds an extra order that has nothing to refund, and never one that is already being refunded", async () => {
    const id = await paidRegistration(a);
    const second = await secondOrder(id, 0, "_a3");
    testProviderControl.settle(second, "paid");
    await paymentWebhook(second);
    expect((await payDoc(id)).flags).toContain("duplicate_payment_unrefundable");
    expect((await payDoc(id)).refunds).toEqual([]);

    const third = await secondOrder(id, 5000, "_a4");
    testProviderControl.settle(third, "paid");
    await paymentWebhook(third);
    await paymentWebhook(third);
    expect((await payDoc(id)).refunds).toHaveLength(1);
    expect(testProviderControl.order(third)!.refunds.size).toBe(1);
  });

  it("does not release a payment that is under review, even when a correct payment is read afterwards", async () => {
    const created = await reg(a);
    const id = created.body.registration.id as string;
    await checkout(a, id);
    testProviderControl.settle(id, "paid", { amountPaise: 100 });
    await paymentWebhook(id);
    expect(await regDoc(id)).toMatchObject({ status: "pending_payment", paymentStatus: "needs_review" });

    testProviderControl.settle(id, "paid", { amountPaise: 50000 });
    await paymentWebhook(id);
    expect(await regDoc(id)).toMatchObject({ status: "pending_payment", paymentStatus: "needs_review" });
    expect(await payDoc(id)).toMatchObject({ status: "needs_review" });
  });

  it("only returns money for a review that actually captured some", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await db().collection(COLLECTIONS.payments).doc(id).update({ status: "needs_review" }); // in review, nothing captured
    const res = await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: admin.idToken, body: { action: "review" } });
    expect(res.status).toBe(422);
    expect(await regDoc(id)).toMatchObject({ status: "pending_payment" });
  });

  it("returns the order that was actually captured when a mismatch is resolved", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await checkout(a, id);
    testProviderControl.settle(id, "paid", { amountPaise: 700 });
    await paymentWebhook(id);
    const res = await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: admin.idToken, body: { action: "review" } });
    expect(res.status).toBe(200);
    const pay = await payDoc(id);
    expect(pay.refunds[0]).toMatchObject({ orderId: id, amountPaise: 700, status: "success" });
    expect(testProviderControl.order(id)!.refunds.size).toBe(1);
  });
});

/* ───────────── H7 — payments are bound to the merchant account ───────────── */

describe("H7: payment account version binding", () => {
  it("records the provider, mode, credentials version and merchant on every payment", async () => {
    const id = (await reg(a)).body.registration.id as string;
    expect(await payDoc(id)).toMatchObject({ provider: "test", mode: "sandbox", credentialsVersion: 1, merchantId: "m-1" });
  });

  it("holds an unpaid payment for review when the merchant changes — nothing is verified, confirmed, checked out or expired", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await checkout(a, id);
    testProviderControl.settle(id, "paid"); // the customer really paid, under the old merchant

    await changeMerchant("m-2");
    expect(await accountDoc()).toMatchObject({ credentialsVersion: 2, merchantId: "m-2", merchantName: "Test merchant (m-2)", status: "active" });

    // Flagged the moment the account changed.
    expect(await regDoc(id)).toMatchObject({ status: "pending_payment", paymentStatus: "needs_review" });
    expect(await payDoc(id)).toMatchObject({ status: "needs_review" });
    expect((await payDoc(id)).flags).toContain("account_changed:credentials_changed");

    // A webhook signed with the new credentials is acknowledged and held, not applied.
    const hook = await send({ type: "payment", orderId: id }, NEW_SECRET);
    expect(hook.status).toBe(200);
    expect(hook.body.result).toBe("held");
    expect(await regDoc(id)).toMatchObject({ status: "pending_payment", paymentStatus: "needs_review" });

    // Checkout refuses; the sweep neither confirms nor releases.
    expect((await checkout(a, id)).status).toBe(409);
    await db().collection(COLLECTIONS.registrations).doc(id).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - 5000) });
    expect(await expirePendingHolds()).toMatchObject({ expired: 0, confirmed: 0 });
    expect((await regDoc(id)).status).toBe("pending_payment");
    expect((await eventDoc()).registeredCount).toBe(1);
  });

  it("lets staff release a frozen hold, and only staff of that fest", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await changeMerchant("m-2");
    const body = { action: "release" };
    expect((await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, body })).status).toBe(401);
    expect((await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: a.idToken, body })).status).toBe(403);
    expect((await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: otherAdmin.idToken, body })).status).toBe(403);
    expect((await regDoc(id)).status).toBe("pending_payment");

    const released = await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: admin.idToken, body });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(await regDoc(id)).toMatchObject({ status: "cancelled", paymentStatus: "cancelled" });
    expect((await payDoc(id)).flags).toContain("released_after_account_change");
    expect((await eventDoc()).registeredCount).toBe(0);
    // Not repeatable, and not available for an ordinary hold.
    expect((await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: admin.idToken, body })).status).toBe(422);
    const ordinary = (await reg(b)).body.registration.id as string;
    expect((await callRoute(refundRoute, { path: "/x", params: { registrationId: ordinary }, token: admin.idToken, body })).status).toBe(422);
  });

  it("the staff 'resolve' button releases a frozen hold (nothing was captured, so nothing is refunded)", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await changeMerchant("m-2");
    const res = await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: admin.idToken, body: { action: "review" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toEqual({ released: true });
    expect(await regDoc(id)).toMatchObject({ status: "cancelled", paymentStatus: "cancelled" });
    expect((await payDoc(id)).refunds).toEqual([]);
  });

  it("keeps a payment working when the same merchant's credentials are rotated", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await checkout(a, id);
    testProviderControl.settle(id, "paid");

    await changeMerchant("m-1", NEW_SECRET);
    expect(await accountDoc()).toMatchObject({ credentialsVersion: 2, merchantId: "m-1" });
    expect(await regDoc(id)).toMatchObject({ status: "pending_payment", paymentStatus: "pending" });

    expect((await paymentWebhook(id)).status).toBe(401); // old secret no longer valid
    const ok = await send({ type: "payment", orderId: id }, NEW_SECRET);
    expect(ok.body.result).toBe("applied");
    expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
  });

  it("will not send a refund through a different merchant account", async () => {
    const id = await paidRegistration(a);
    await cancelReg(a, id);
    expect(await regDoc(id)).toMatchObject({ paymentStatus: "refund_pending" });

    await changeMerchant("m-2");
    const approve = await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: admin.idToken, body: { action: "approve" } });
    expect(approve.status).toBe(409);
    expect(await retryAutoRefunds()).toBe(0);
    expect(await executeRefund(id, `${id}_r1`)).toBe("blocked");

    expect(testProviderControl.order(id)!.refunds.size).toBe(0);
    const pay = await payDoc(id);
    expect(pay.flags).toContain("account_changed:credentials_changed");
    expect(pay).toMatchObject({ status: "refund_pending", openRefunds: true });
    expect(pay.refunds[0].status).toBe("requested");
    expect(await regDoc(id)).toMatchObject({ status: "cancelled", paymentStatus: "refund_pending" });
  });

  it("will not refund (or verify) with a different provider or mode than the payment was made under", async () => {
    const id = await paidRegistration(a);
    await cancelReg(a, id);
    await db().collection(COLLECTIONS.payments).doc(id).update({ mode: "live" });
    expect(await executeRefund(id, `${id}_r1`)).toBe("blocked");
    await db().collection(COLLECTIONS.payments).doc(id).update({ mode: "sandbox", provider: "somebody-else" });
    expect(await executeRefund(id, `${id}_r1`)).toBe("blocked");
    expect(testProviderControl.order(id)!.refunds.size).toBe(0);
    // Restore it and the refund goes through.
    await db().collection(COLLECTIONS.payments).doc(id).update({ provider: "test" });
    expect(await executeRefund(id, `${id}_r1`)).toBe("success");
  });

  it("leaves a settled payment's ticket alone when the account changes — only its refund path is blocked", async () => {
    const id = await paidRegistration(a);
    await changeMerchant("m-2");
    expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect(await payDoc(id)).toMatchObject({ status: "paid" });
  });

  it("refuses to switch provider or mode while money is open, and allows it when nothing is", async () => {
    const account = { festId: "fest1", provider: "test", mode: "sandbox", status: "active" } as const;
    await assertSafeAccountChange("fest1", account, { provider: "test", mode: "live" }); // nothing open: fine
    const id = (await reg(a)).body.registration.id as string;
    await assertSafeAccountChange("fest1", account, { provider: "test", mode: "sandbox" }); // same: fine even with an open hold
    await expect(assertSafeAccountChange("fest1", account, { provider: "test", mode: "live" })).rejects.toMatchObject({ status: 409 });
    await expect(assertSafeAccountChange("fest1", account, { provider: "other", mode: "sandbox" })).rejects.toMatchObject({ status: 409 });
    // A refund still owed counts as open too.
    await db().collection(COLLECTIONS.payments).doc(id).update({ status: "paid", openRefunds: true });
    await expect(assertSafeAccountChange("fest1", account, { provider: "test", mode: "live" })).rejects.toMatchObject({ status: 409 });
    await db().collection(COLLECTIONS.payments).doc(id).update({ status: "paid", openRefunds: false });
    await assertSafeAccountChange("fest1", account, { provider: "test", mode: "live" });
    // Another fest's money is not this fest's business.
    await assertSafeAccountChange("fest2", account, { provider: "test", mode: "live" });
  });
});

/* ───────────── credential checks and the settings route ───────────── */

describe("saving credentials", () => {
  const put = (user: TestUser | null, credentials: Record<string, string>) => callRoute(putPayments, { method: "PUT", path: "/x", params: { id: "fest1" }, ...(user ? { token: user.idToken } : {}), body: { provider: "test", mode: "sandbox", credentials } });

  it("asks the provider who they belong to, stores that identity, and bumps the version", async () => {
    const res = await put(admin, { webhookSecret: "whsec_brand_new_1", merchantId: "m-9" });
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ merchantId: "m-9", merchantName: "Test merchant (m-9)", credentialsVersion: 2, status: "pending_review" });
    expect(await accountDoc()).toMatchObject({ credentialsVersion: 2, merchantId: "m-9" });
    const read = await callRoute(getPayments, { path: "/x", params: { id: "fest1" }, token: admin.idToken });
    expect(read.body.account.merchantName).toBe("Test merchant (m-9)");
    expect(JSON.stringify(read.body)).not.toContain("whsec_brand_new_1");
  });

  it("stores nothing when the provider does not accept the credentials", async () => {
    const before = (await db().collection(COLLECTIONS.paymentSecrets).doc("fest1").get()).data();
    const res = await put(admin, { webhookSecret: "short" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/provider didn't accept/);
    expect((await db().collection(COLLECTIONS.paymentSecrets).doc("fest1").get()).data()).toEqual(before);
    expect(await accountDoc()).toMatchObject({ credentialsVersion: 1, status: "active" });
  });

  it("never echoes a credential back, even when the provider's own error contains it", async () => {
    testProviderControl.failWith(`401 for webhookSecret=whsec_leaky_value_99 on Bearer whsec_leaky_value_99`);
    const res = await put(admin, { webhookSecret: "whsec_leaky_value_99" });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain("whsec_leaky_value_99");
  });

  it("is refused for staff of another fest, students and anonymous callers", async () => {
    expect((await put(null, { webhookSecret: "whsec_brand_new_1" })).status).toBe(401);
    expect((await put(a, { webhookSecret: "whsec_brand_new_1" })).status).toBe(403);
    expect((await put(otherAdmin, { webhookSecret: "whsec_brand_new_1" })).status).toBe(403);
    expect(await accountDoc()).toMatchObject({ credentialsVersion: 1 });
  });
});

/* ───────────── refunds: lookup, idempotency, verification ───────────── */

describe("refunds resolve against the provider", () => {
  const cancelAndApprove = async (id: string) => {
    await cancelReg(a, id);
    return callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: admin.idToken, body: { action: "approve" } });
  };

  it("a duplicate request resolves to the refund that exists — one refund, however many callers", async () => {
    const id = await paidRegistration(a);
    await cancelReg(a, id);
    const results = await Promise.all([executeRefund(id, `${id}_r1`), executeRefund(id, `${id}_r1`), executeRefund(id, `${id}_r1`)]);
    expect(results.every((r) => r === "success" || r === "skipped")).toBe(true);
    expect(testProviderControl.order(id)!.refunds.size).toBe(1);
    expect(await payDoc(id)).toMatchObject({ status: "refunded", openRefunds: false });
  });

  it("a refund the provider already holds is recorded as it is, never requested again", async () => {
    const id = await paidRegistration(a);
    await cancelReg(a, id);
    // Created at the provider, but our record never heard back (crash after the call).
    await testProvider.refund({ mode: "sandbox", credentials: {} }, { orderId: id, refundId: `${id}_r1`, amountPaise: 50000 });
    expect(await executeRefund(id, `${id}_r1`)).toBe("success");
    expect(testProviderControl.order(id)!.refunds.size).toBe(1);
    expect(await payDoc(id)).toMatchObject({ status: "refunded" });
  });

  it("a refund webhook is a hint: the refund is read back, and a pending refund is not turned into a success by the body", async () => {
    const id = await paidRegistration(a);
    testProviderControl.setNextRefund("pending");
    expect((await cancelAndApprove(id)).status).toBe(200);
    const recordId = `${id}_r1`;
    expect((await payDoc(id)).refunds[0].status).toBe("pending");

    // The webhook claims success; the provider still says pending. Nothing is believed, and the delivery is not
    // acknowledged as handled: the provider is asked to send it again once its own record agrees.
    expect((await send({ type: "refund", orderId: id, refundId: recordId, status: "success" })).status).toBe(503);
    expect((await payDoc(id)).refunds[0].status).toBe("pending");
    expect(await regDoc(id)).toMatchObject({ paymentStatus: "refund_pending" });

    // Once the provider really has finished it, the same kind of webhook completes it.
    testProviderControl.settleRefund(id, recordId, "success");
    await send({ type: "refund", orderId: id, refundId: recordId, status: "pending" });
    expect(await payDoc(id)).toMatchObject({ status: "refunded" });
    expect(await regDoc(id)).toMatchObject({ paymentStatus: "refunded" });
  });

  it("a refund webhook that is ahead of the provider is asked to be sent again, and is accepted once the provider agrees", async () => {
    const id = await paidRegistration(a);
    testProviderControl.setNextRefund("pending");
    expect((await cancelAndApprove(id)).status).toBe(200);
    const recordId = `${id}_r1`;
    const claim = { type: "refund", orderId: id, refundId: recordId, status: "success", eventId: "evt_ahead_1" };
    const post = () => callRoute(webhook, { path: "/api/payments/webhook/test", params: { provider: "test" }, body: claim, headers: testProviderControl.signedWebhook(claim, SECRET).headers });

    // The same delivery, twice: refused with a retry request while the provider still says pending; nothing is finished.
    expect((await post()).status).toBe(503);
    expect((await post()).status).toBe(503);
    expect((await payDoc(id)).refunds[0].status).toBe("pending");
    expect(await regDoc(id)).toMatchObject({ paymentStatus: "refund_pending" });

    // The provider catches up; the redelivery of that very event is now handled and acknowledged.
    testProviderControl.settleRefund(id, recordId, "success");
    expect((await post()).status).toBe(200);
    expect(await payDoc(id)).toMatchObject({ status: "refunded" });
    expect(await regDoc(id)).toMatchObject({ paymentStatus: "refunded" });
    // ...and a further redelivery is recognised as a duplicate.
    expect((await post()).status).toBe(200);
  });

  it("a refund webhook for a refund the provider has never heard of changes nothing", async () => {
    const id = await paidRegistration(a);
    testProviderControl.setNextRefund("pending");
    await cancelAndApprove(id);
    const before = await payDoc(id);
    const res = await send({ type: "refund", orderId: id, refundId: `${id}_r9`, status: "success" });
    expect(res.status).toBe(200);
    expect((await payDoc(id)).refunds).toEqual(before.refunds);
  });

  it("flags a refund whose amount is not what was asked for", async () => {
    const id = await paidRegistration(a);
    testProviderControl.setNextRefund("pending");
    await cancelAndApprove(id);
    const recordId = `${id}_r1`;
    testProviderControl.settleRefund(id, recordId, "success");
    testProviderControl.setRefundAmount(id, recordId, 49000);
    await send({ type: "refund", orderId: id, refundId: recordId, status: "success" });
    expect((await payDoc(id)).flags).toContain("refund_amount_mismatch");
  });

  it("asks again under a new provider refund id after a definitive failure, and stops after the attempt limit", async () => {
    const id = await paidRegistration(a);
    await cancelReg(a, id);
    testProviderControl.setNextRefund("failed");
    // Attempt 1 fails at the provider; the next calls each move to a fresh provider refund id.
    for (let i = 0; i < MAX_REFUND_ATTEMPTS + 2; i += 1) await executeRefund(id, `${id}_r1`);
    expect(testProviderControl.order(id)!.refunds.size).toBe(MAX_REFUND_ATTEMPTS);
    expect([...testProviderControl.order(id)!.refunds.keys()]).toEqual([`${id}_r1`, `${id}_r1_a2`, `${id}_r1_a3`, `${id}_r1_a4`, `${id}_r1_a5`]);
    expect((await payDoc(id)).refunds[0]).toMatchObject({ status: "failed", attempt: MAX_REFUND_ATTEMPTS });

    // Fresh scenario: the first attempt fails, the second goes through.
    const other = await paidRegistration(b);
    await cancelReg(b, other);
    testProviderControl.setNextRefund("failed");
    expect(await executeRefund(other, `${other}_r1`)).toBe("failed");
    testProviderControl.setNextRefund("success");
    expect(await executeRefund(other, `${other}_r1`)).toBe("success");
    expect([...testProviderControl.order(other)!.refunds.keys()]).toEqual([`${other}_r1`, `${other}_r1_a2`]);
    expect(await payDoc(other)).toMatchObject({ status: "refunded", openRefunds: false });
  });

  it("an event cancellation does not send refunds through a changed account either", async () => {
    const id = await paidRegistration(a);
    await changeMerchant("m-2");
    const res = await callRoute(updateEvent, { method: "PATCH", path: "/x", params: { id: "ev1" }, token: admin.idToken, body: { status: "cancelled" } });
    expect(res.status).toBe(200);
    expect(testProviderControl.order(id)!.refunds.size).toBe(0);
    expect((await payDoc(id)).refunds[0].status).toBe("requested");
    expect(await regDoc(id)).toMatchObject({ paymentStatus: "refund_pending" });
  });
});

/* ───────────── errors and checkout addresses ───────────── */

describe("what leaves the server", () => {
  it("a provider failure during checkout reaches neither the response nor the logs with a credential in it", async () => {
    const id = (await reg(a)).body.registration.id as string;
    const spies = (["log", "info", "warn", "error"] as const).map((level) => vi.spyOn(console, level));
    try {
      testProviderControl.failWith(`upstream rejected key ${SECRET} (Authorization: Bearer ${SECRET})`);
      const res = await checkout(a, id);
      expect(res.status).toBe(502);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      const logged = spies.flatMap((spy) => spy.mock.calls).map((call) => call.map(String).join(" ")).join("\n");
      expect(logged).not.toContain(SECRET);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  });

  it("refuses a checkout address that is not on the provider's hosts, and returns nothing to the browser", async () => {
    const id = (await reg(a)).body.registration.id as string;
    for (const bad of ["https://evil.example/pay", "http://test-provider.invalid/pay", "javascript:alert(1)"]) {
      testProviderControl.setRedirectUrl(bad);
      const res = await checkout(a, id);
      expect(res.status, bad).toBe(502);
      expect(JSON.stringify(res.body), bad).not.toContain("evil.example");
    }
    testProviderControl.setRedirectUrl(null);
    const ok = await checkout(a, id);
    expect(ok.status).toBe(200);
    expect(ok.body.checkout.redirectUrl).toBe(`https://test-provider.invalid/pay/${id}`);
  });
});

/* ───────────── key rotation ───────────── */

describe("re-encrypting stored credentials", () => {
  const keyA = Buffer.alloc(32, 7).toString("base64");
  const keyB = Buffer.alloc(32, 9).toString("base64");

  const legacyBlob = (credentials: Record<string, string>, festId: string, base64Key: string) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(base64Key, "base64"), iv);
    cipher.setAAD(Buffer.from(festId, "utf8"));
    const data = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
    return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  };
  const rotate = (user: TestUser | null, body: Record<string, unknown> = {}) => callRoute(keysRoute, { path: "/api/admin/payments/keys", ...(user ? { token: user.idToken } : {}), body });

  it("is for platform administrators only", async () => {
    expect((await rotate(null)).status).toBe(401);
    expect((await rotate(a)).status).toBe(403);
    expect((await rotate(admin)).status).toBe(403);
    expect((await rotate(superAdmin)).status).toBe(200);
  });

  it("reports by default and changes nothing; a real run moves legacy and old-key blobs to the current key, once", async () => {
    // fest1: sealed under the old key A (v2). fest2: legacy v1 under A. fest3: unreadable by any key on the ring.
    await db().collection(COLLECTIONS.paymentSecrets).doc("fest1").set({ festId: "fest1", blob: encryptCredentials({ webhookSecret: SECRET }, "fest1") });
    await db().collection(COLLECTIONS.paymentSecrets).doc("fest2").set({ festId: "fest2", blob: legacyBlob({ webhookSecret: "legacy-secret-value" }, "fest2", keyA) });
    process.env.PAYMENT_SECRET_KEY = Buffer.alloc(32, 99).toString("base64");
    await db().collection(COLLECTIONS.paymentSecrets).doc("fest3").set({ festId: "fest3", blob: encryptCredentials({ webhookSecret: "unreadable" }, "fest3") });

    process.env.PAYMENT_SECRET_KEY = keyB;
    process.env.PAYMENT_SECRET_KEYS_PREVIOUS = keyA;
    try {
      const snapshotBefore = JSON.stringify((await db().collection(COLLECTIONS.paymentSecrets).get()).docs.map((d) => [d.id, d.data().blob]));
      const dry = await rotate(superAdmin);
      expect(dry.body.report).toMatchObject({ dryRun: true, total: 3, rewrapped: 2, alreadyCurrent: 0, undecryptable: ["fest3"] });
      expect(JSON.stringify((await db().collection(COLLECTIONS.paymentSecrets).get()).docs.map((d) => [d.id, d.data().blob]))).toBe(snapshotBefore);

      const real = await rotate(superAdmin, { dryRun: false });
      expect(real.body.report).toMatchObject({ dryRun: false, rewrapped: 2, undecryptable: ["fest3"] });
      expect(JSON.stringify(real.body)).not.toContain("legacy-secret-value");
      const blob2 = (await db().collection(COLLECTIONS.paymentSecrets).doc("fest2").get()).data()!.blob;
      expect(blob2).toMatchObject({ v: 2, kid: real.body.report.currentKeyId });
      // The unreadable one is untouched, not deleted.
      expect((await db().collection(COLLECTIONS.paymentSecrets).doc("fest3").get()).exists).toBe(true);

      // Idempotent, and the old key is no longer needed for what was moved.
      const again = await rotate(superAdmin, { dryRun: false });
      expect(again.body.report).toMatchObject({ rewrapped: 0, alreadyCurrent: 2, undecryptable: ["fest3"] });
      delete process.env.PAYMENT_SECRET_KEYS_PREVIOUS;
      const afterDrop = await rotate(superAdmin);
      expect(afterDrop.body.report).toMatchObject({ alreadyCurrent: 2, undecryptable: ["fest3"] });
    } finally {
      process.env.PAYMENT_SECRET_KEY = keyA;
      delete process.env.PAYMENT_SECRET_KEYS_PREVIOUS;
    }
  });

  it("payments keep working across a rotation", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await checkout(a, id);
    testProviderControl.settle(id, "paid");
    process.env.PAYMENT_SECRET_KEY = keyB;
    process.env.PAYMENT_SECRET_KEYS_PREVIOUS = keyA;
    try {
      expect((await paymentWebhook(id)).body.result).toBe("applied"); // opens the old blob with the previous key
      await rotate(superAdmin, { dryRun: false });
      delete process.env.PAYMENT_SECRET_KEYS_PREVIOUS;
      const second = await paidRegistration(b); // and new work needs only the new key
      expect(await regDoc(second)).toMatchObject({ status: "confirmed" });
    } finally {
      process.env.PAYMENT_SECRET_KEY = keyA;
      delete process.env.PAYMENT_SECRET_KEYS_PREVIOUS;
    }
  });
});

/* ───────────── the lifecycle itself ───────────── */

describe("applying a snapshot directly", () => {
  it("reports a changed settled order as flagged and a replay as a no-op", async () => {
    const id = await paidRegistration(a);
    expect(await applyOrderSnapshot(id, { orderId: id, status: "paid", amountPaise: 50000, currency: "INR", providerPaymentId: `pay_${id}` })).toMatchObject({ kind: "noop" });
    expect(await applyOrderSnapshot(id, { orderId: id, status: "paid", amountPaise: 49999, currency: "INR", providerPaymentId: `pay_${id}` })).toMatchObject({ kind: "flagged" });
  });
});
