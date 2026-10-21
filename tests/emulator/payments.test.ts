import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb, COLLECTIONS, FieldValue, Timestamp } from "@/server/firebase-admin";
import { POST as register } from "@/app/api/registrations/route";
import { POST as cancel } from "@/app/api/registrations/[id]/cancel/route";
import { POST as team } from "@/app/api/registrations/[id]/team/route";
import { POST as startPayment } from "@/app/api/registrations/[id]/payment/route";
import { POST as webhook } from "@/app/api/payments/webhook/[provider]/route";
import { GET as cron } from "@/app/api/cron/payments/route";
import { POST as staffAction } from "@/app/api/admin/registrations/[id]/route";
import { POST as refundRoute } from "@/app/api/admin/payments/[registrationId]/refund/route";
import { GET as getPayments, PUT as putPayments, POST as reviewPayments } from "@/app/api/admin/fests/[id]/payments/route";
import { POST as createEvent } from "@/app/api/admin/events/route";
import { PATCH as updateEvent } from "@/app/api/admin/events/[id]/route";
import { encryptCredentials } from "@/server/payments/secrets";
import { testProvider, testProviderControl } from "@/server/payments/providers/test-provider";
import { applyOrderSnapshot, expirePendingHolds, retryAutoRefunds } from "@/server/payments/lifecycle";
import { callRoute, eventDoc, festDoc, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * Optional paid registration, end to end against the route handlers and the
 * Firestore emulator, with the in-repo test provider standing in for a gateway.
 * No real provider, credential or charge is involved anywhere.
 */

const WEBHOOK_SECRET = "whsec_unit_test_only";
const ENV_KEYS = ["PAYMENTS_ENABLED", "PAYMENTS_LIVE_ENABLED", "PAYMENTS_ALLOW_TEST_PROVIDER", "PAYMENT_SECRET_KEY", "CRON_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};

let a: TestUser;
let b: TestUser;
let c: TestUser;
let admin: TestUser;
let otherAdmin: TestUser;
let superAdmin: TestUser;

const db = () => adminDb();
const regDoc = async (id: string) => (await db().collection(COLLECTIONS.registrations).doc(id).get()).data()!;
const payDoc = async (id: string) => (await db().collection(COLLECTIONS.payments).doc(id).get()).data();
const emails = async (to: string, template: string) => (await db().collection(COLLECTIONS.emailLog).where("to", "==", to).where("template", "==", template).get()).size;
const noteTypes = async (user: TestUser) => (await db().collection(COLLECTIONS.notifications).where("userId", "==", user.uid).get()).docs.map((d) => d.data().type as string);

const seedAccount = async (over: Record<string, unknown> = {}) => {
  await db().collection(COLLECTIONS.paymentSecrets).doc("fest1").set({ festId: "fest1", blob: encryptCredentials({ webhookSecret: WEBHOOK_SECRET }, "fest1"), updatedAt: new Date() });
  await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").set({ festId: "fest1", provider: "test", mode: "sandbox", status: "active", updatedAt: new Date(), ...over });
};

const seedPaidEvent = (over: Record<string, unknown> = {}) => seedEvent({ entryFee: 500, paymentEnabled: true, ...over });

const reg = (user: TestUser, body: Record<string, unknown> = {}) =>
  callRoute(register, { path: "/api/registrations", token: user.idToken, body: { eventId: "ev1", teamName: `${user.name} solo`, members: [{ name: user.name, email: user.email }], ...body } });

const checkout = (user: TestUser, id: string) => callRoute(startPayment, { path: `/api/registrations/${id}/payment`, token: user.idToken, params: { id }, body: {} });

let eventCounter = 0;
const send = (body: Record<string, unknown>, opts: { secret?: string; provider?: string; headers?: Record<string, string> } = {}) => {
  const full = { eventId: `evt_${(eventCounter += 1)}`, ...body };
  const signed = testProviderControl.signedWebhook(full, opts.secret ?? WEBHOOK_SECRET);
  return callRoute(webhook, { path: `/api/payments/webhook/${opts.provider ?? "test"}`, params: { provider: opts.provider ?? "test" }, body: full, headers: opts.headers ?? signed.headers });
};
const paymentWebhook = (orderId: string, extra: Record<string, unknown> = {}) => send({ type: "payment", orderId, ...extra });

/** Register for the paid event and have the customer pay (provider side), returning the registration id. */
const registerAndPay = async (user: TestUser, body: Record<string, unknown> = {}) => {
  const created = await reg(user, body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.registration.id as string;
  expect((await checkout(user, id)).status).toBe(200);
  testProviderControl.settle(id, "paid");
  return id;
};

const cancelRegistration = (user: TestUser, id: string) => callRoute(cancel, { path: `/api/registrations/${id}/cancel`, token: user.idToken, params: { id }, body: {} });

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.PAYMENTS_ENABLED = "1";
  process.env.PAYMENTS_ALLOW_TEST_PROVIDER = "1";
  process.env.PAYMENT_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.CRON_SECRET = "cron-secret-for-tests";
  delete process.env.PAYMENTS_LIVE_ENABLED;

  await resetAuth();
  a = await mintUser({ name: "Alice" });
  b = await mintUser({ name: "Bob" });
  c = await mintUser({ name: "Chen" });
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
  for (const u of [a, b, c]) {
    await db().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, fullName: u.name, name: u.name, role: "student", emailVerified: true, student: { college: "T" }, createdAt: new Date(), updatedAt: new Date() });
  }
  for (const u of [admin, otherAdmin, superAdmin]) {
    await db().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, name: u.name, role: u.role, festIds: u.role === "admin" ? (u === admin ? ["fest1"] : ["fest2"]) : [], profileCompleted: true, createdAt: new Date(), updatedAt: new Date() });
  }
  await seedFest({ ownerId: admin.uid });
  await seedFest({ id: "fest2", slug: "other", name: "Other fest", ownerId: otherAdmin.uid });
  await seedAccount();
  await seedPaidEvent();
});

/* ───────────── free events are untouched ───────────── */

describe("free registration is unaffected", () => {
  it("registers a free event exactly as before — no payment document, no payment fields", async () => {
    await seedEvent();
    const res = await reg(a);
    expect(res.status).toBe(201);
    expect(res.body.registration.status).toBe("confirmed");
    expect(res.body.registration.paymentStatus).toBeUndefined();
    expect(res.body.registration.holdExpiresAt).toBeUndefined();
    expect((await db().collection(COLLECTIONS.payments).get()).size).toBe(0);
    expect(await emails(a.email, "registration_confirmed")).toBe(1);
  });

  it("a free event needs no payment account, and works with payments switched off platform-wide", async () => {
    delete process.env.PAYMENTS_ENABLED;
    await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").delete();
    await seedEvent();
    try {
      const res = await reg(a);
      expect(res.status).toBe(201);
      expect(res.body.registration.status).toBe("confirmed");
    } finally {
      process.env.PAYMENTS_ENABLED = "1";
    }
  });

  it("an existing event with a fee but no payment switch keeps today's behaviour: free registration, fee shown only", async () => {
    await seedEvent({ entryFee: 500 });
    const res = await reg(a);
    expect(res.status).toBe(201);
    expect(res.body.registration.status).toBe("confirmed");
    expect((await db().collection(COLLECTIONS.payments).get()).size).toBe(0);
  });
});

/* ───────────── a paid registration ───────────── */

describe("paid registration", () => {
  it("is refused — never silently made free — while payments are off for the deployment or the fest", async () => {
    delete process.env.PAYMENTS_ENABLED;
    try {
      const off = await reg(a);
      expect(off.status).toBe(422);
      expect(off.body.error).toMatch(/isn't available/);
    } finally {
      process.env.PAYMENTS_ENABLED = "1";
    }
    await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").update({ status: "pending_review" });
    expect((await reg(a)).status).toBe(422);
    await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").delete();
    expect((await reg(a)).status).toBe(422);
    expect((await eventDoc()).registeredCount).toBe(0);
    expect((await db().collection(COLLECTIONS.registrations).get()).size).toBe(0);
  });

  it("refuses a live-mode account until the live switch is on", async () => {
    await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").update({ mode: "live" });
    expect((await reg(a)).status).toBe(422);
  });

  it("holds the seat as pending_payment with a server-computed amount, and admits nothing yet", async () => {
    const res = await reg(a);
    expect(res.status).toBe(201);
    const r = res.body.registration;
    expect(r).toMatchObject({ status: "pending_payment", paymentStatus: "pending", amountPaise: 50000 });
    expect(typeof r.holdExpiresAt).toBe("string");
    expect((await eventDoc()).registeredCount).toBe(1);
    expect((await festDoc()).stats.registrations).toBe(1);

    expect(await payDoc(r.id)).toMatchObject({ amountPaise: 50000, currency: "INR", status: "created", provider: "test", mode: "sandbox", userId: a.uid });
    // A prompt to pay — not a confirmation, not a ticket email.
    expect(await noteTypes(a)).toEqual(["payment_required"]);
    expect(await emails(a.email, "registration_confirmed")).toBe(0);
  });

  it("ignores any amount the client sends", async () => {
    const res = await reg(a, { amountPaise: 1, amount: 1, entryFee: 0, paymentStatus: "paid" });
    expect(res.status).toBe(201);
    expect(res.body.registration).toMatchObject({ status: "pending_payment", paymentStatus: "pending", amountPaise: 50000 });
  });

  it("does not let the same person hold two seats", async () => {
    expect((await reg(a)).status).toBe(201);
    expect((await reg(a)).status).toBe(409);
    expect((await eventDoc()).registeredCount).toBe(1);
  });

  it("holds seats against capacity, so a full event refuses the next person", async () => {
    await seedPaidEvent({ capacity: 1 });
    expect((await reg(a)).status).toBe(201);
    const second = await reg(b);
    expect(second.status).toBe(422);
    expect(second.body.error).toMatch(/full/i);
  });

  it("releases lapsed holds on demand, so a full-looking event heals without waiting for the sweep", async () => {
    await seedPaidEvent({ capacity: 1 });
    const first = (await reg(a)).body.registration.id as string;
    expect((await reg(b)).status).toBe(422);
    await db().collection(COLLECTIONS.registrations).doc(first).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    const second = await reg(b);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(await regDoc(first)).toMatchObject({ status: "cancelled", paymentStatus: "expired" });
    expect((await eventDoc()).registeredCount).toBe(1);
  });

  it("never exceeds capacity under simultaneous requests", async () => {
    await seedPaidEvent({ capacity: 2 });
    const results = await Promise.all([reg(a), reg(b), reg(c)]);
    const created = results.filter((r) => r.status === 201).length;
    expect(created).toBeGreaterThanOrEqual(1);
    expect(created).toBeLessThanOrEqual(2);
    expect((await eventDoc()).registeredCount).toBe(created);
    expect((await db().collection(COLLECTIONS.payments).get()).size).toBe(created);
  });
});

/* ───────────── checkout ───────────── */

describe("starting a checkout", () => {
  it("creates one order with the server's amount and returns the same one on repeat", async () => {
    const id = (await reg(a)).body.registration.id as string;
    const first = await checkout(a, id);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ state: "checkout", orderId: id, amountPaise: 50000 });
    expect(first.body.checkout.redirectUrl).toContain(id);
    expect(testProviderControl.order(id)).toMatchObject({ amountPaise: 50000, currency: "INR", status: "pending" });

    const second = await checkout(a, id);
    expect(second.status).toBe(200);
    expect(second.body.orderId).toBe(id);
    expect((await payDoc(id))!.status).toBe("pending");
  });

  it("requires sign-in and ownership, and says nothing about other people's registrations", async () => {
    const id = (await reg(a)).body.registration.id as string;
    expect((await callRoute(startPayment, { path: "/x", params: { id }, body: {} })).status).toBe(401);
    expect((await checkout(b, id)).status).toBe(404);
  });

  it("refuses once the hold has lapsed", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await db().collection(COLLECTIONS.registrations).doc(id).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    const res = await checkout(a, id);
    expect(res.status).toBe(409);
  });

  it("answers 'paid' — and confirms — when the money already arrived but the webhook has not", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await checkout(a, id);
    testProviderControl.settle(id, "paid");
    const res = await checkout(a, id);
    expect(res.body.state).toBe("paid");
    expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
  });

  it("is reported honestly when the provider is unreachable, and keeps the seat", async () => {
    const id = (await reg(a)).body.registration.id as string;
    testProviderControl.setDown(true);
    const res = await checkout(a, id);
    expect(res.status).toBe(502);
    expect((await regDoc(id)).status).toBe("pending_payment");
  });
});

/* ───────────── webhooks ───────────── */

describe("payment webhooks", () => {
  it("confirm the registration once the provider's own record shows the right payment", async () => {
    const id = await registerAndPay(a);
    const res = await paymentWebhook(id);
    expect(res.status).toBe(200);
    expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect((await regDoc(id)).holdExpiresAt).toBeUndefined();
    expect(await payDoc(id)).toMatchObject({ status: "paid", paidOrderId: id });
    expect(await emails(a.email, "registration_confirmed")).toBe(1);
    expect((await noteTypes(a)).sort()).toEqual(["payment_required", "registration_confirmed"]);
    expect((await eventDoc()).registeredCount).toBe(1);
  });

  it("are idempotent: a duplicate delivery changes nothing and sends nothing twice", async () => {
    const id = await registerAndPay(a);
    const body = { eventId: "evt_dup", type: "payment", orderId: id };
    const signed = testProviderControl.signedWebhook(body, WEBHOOK_SECRET);
    const call = () => callRoute(webhook, { path: "/api/payments/webhook/test", params: { provider: "test" }, body, headers: signed.headers });
    expect((await call()).body.result).toBe("applied");
    expect((await call()).body.result).toBe("duplicate");
    // A *different* delivery of the same payment (the provider's own retry with a new event id) is also harmless.
    expect((await paymentWebhook(id)).status).toBe(200);
    expect(await emails(a.email, "registration_confirmed")).toBe(1);
    expect((await eventDoc()).registeredCount).toBe(1);
    expect((await payDoc(id))!.refunds).toEqual([]);
  });

  it("reject a bad or missing signature without touching anything", async () => {
    const id = await registerAndPay(a);
    expect((await paymentWebhook(id)).status).toBe(200); // control: a valid one works
    const id2 = await registerAndPay(b);
    const wrongSecret = await send({ type: "payment", orderId: id2 }, { secret: "not-the-secret" });
    expect(wrongSecret.status).toBe(401);
    const unsigned = await send({ type: "payment", orderId: id2 }, { headers: {} });
    expect(unsigned.status).toBe(401);
    expect(await regDoc(id2)).toMatchObject({ status: "pending_payment", paymentStatus: "pending" });
  });

  it("never believe the body: a 'paid' webhook for an order the provider says is unpaid confirms nothing", async () => {
    const created = await reg(a);
    const id = created.body.registration.id as string;
    await checkout(a, id); // provider order stays pending
    const res = await send({ type: "payment", orderId: id, status: "paid", amountPaise: 50000 });
    expect(res.status).toBe(200);
    expect(await regDoc(id)).toMatchObject({ status: "pending_payment", paymentStatus: "pending" });
  });

  it("acknowledge unknown orders and unknown providers without leaking anything", async () => {
    const unknown = await send({ type: "payment", orderId: "no-such-order" });
    expect(unknown.status).toBe(200);
    expect(unknown.body.result).toBe("ignored");
    expect((await send({ type: "payment", orderId: "x" }, { provider: "mystery" })).status).toBe(404);
    expect((await callRoute(webhook, { path: "/api/payments/webhook/test", params: { provider: "test" }, body: { nonsense: true } })).status).toBe(400);
  });

  it("flag a payment whose amount does not match for review, and never confirm it", async () => {
    const id = await registerAndPay(a);
    testProviderControl.settle(id, "paid", { amountPaise: 100 });
    await paymentWebhook(id);
    expect(await regDoc(id)).toMatchObject({ status: "pending_payment", paymentStatus: "needs_review" });
    expect(await payDoc(id)).toMatchObject({ status: "needs_review", capturedAmountPaise: 100, amountPaise: 50000 });
    expect(await emails(a.email, "registration_confirmed")).toBe(0);

    // The expiry job must not discard a registration that has money attached.
    await db().collection(COLLECTIONS.registrations).doc(id).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    await expirePendingHolds();
    expect((await regDoc(id)).status).toBe("pending_payment");
  });

  it("flag a wrong currency the same way", async () => {
    const id = await registerAndPay(a);
    testProviderControl.settle(id, "paid", { currency: "USD" });
    await paymentWebhook(id);
    expect((await regDoc(id)).paymentStatus).toBe("needs_review");
  });

  it("let staff settle a flagged payment by returning the money and releasing the seat", async () => {
    const id = await registerAndPay(a);
    testProviderControl.settle(id, "paid", { amountPaise: 100 });
    await paymentWebhook(id);

    expect((await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: a.idToken, body: { action: "review" } })).status).toBe(403);
    expect((await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: otherAdmin.idToken, body: { action: "review" } })).status).toBe(403);

    const res = await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: admin.idToken, body: { action: "review" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await regDoc(id)).toMatchObject({ status: "cancelled", paymentStatus: "refunded" });
    expect(await payDoc(id)).toMatchObject({ status: "refunded" });
    expect((await eventDoc()).registeredCount).toBe(0);
    expect(testProviderControl.order(id)!.refunds.size).toBe(1);
  });

  it("record a failed payment, then let the customer retry on a fresh order", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await checkout(a, id);
    testProviderControl.settle(id, "failed", { failureReason: "card declined" });
    await paymentWebhook(id);
    expect(await regDoc(id)).toMatchObject({ status: "pending_payment", paymentStatus: "failed" });
    expect(await payDoc(id)).toMatchObject({ status: "failed" });

    const retry = await checkout(a, id);
    expect(retry.status).toBe(200);
    expect(retry.body.orderId).toBe(`${id}_a2`);
    expect((await regDoc(id)).paymentStatus).toBe("pending");

    testProviderControl.settle(`${id}_a2`, "paid");
    await paymentWebhook(`${id}_a2`);
    expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect(await payDoc(id)).toMatchObject({ status: "paid", paidOrderId: `${id}_a2`, attempt: 2 });
  });

  it("refund the second payment when both attempts end up paid", async () => {
    const id = await registerAndPay(a);
    await paymentWebhook(id);
    // A second, separately paid order for the same registration (two tabs, a retry that also went through).
    const second = `${id}_a2`;
    await testProvider.createOrder({ mode: "sandbox", credentials: {} }, { orderId: second, amountPaise: 50000, currency: "INR", customer: { id: a.uid, name: "A", email: a.email }, returnUrl: "x", notifyUrl: "y", expiresAt: new Date(Date.now() + 60_000) });
    await db().collection(COLLECTIONS.payments).doc(id).update({ orderIds: FieldValue.arrayUnion(second) });
    testProviderControl.settle(second, "paid", { paymentId: "pay_second" });
    await paymentWebhook(second);

    const pay = (await payDoc(id))!;
    expect(pay.flags).toContain("duplicate_payment");
    expect(pay.refunds).toHaveLength(1);
    expect(pay.refunds[0]).toMatchObject({ orderId: second, reason: "duplicate_payment", status: "success" });
    // The registration is unharmed, and the first payment is still the one it relies on.
    expect(pay).toMatchObject({ status: "paid", paidOrderId: id });
    expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect(testProviderControl.order(second)!.refunds.size).toBe(1);
    expect(testProviderControl.order(id)!.refunds.size).toBe(0);
  });
});

/* ───────────── holds that run out ───────────── */

describe("seat holds that expire", () => {
  const lapse = (id: string) => db().collection(COLLECTIONS.registrations).doc(id).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });

  it("release the seat when nothing was paid", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await checkout(a, id);
    expect((await expirePendingHolds()).expired).toBe(0); // not due yet
    await lapse(id);
    const swept = await expirePendingHolds();
    expect(swept.expired).toBe(1);
    expect(await regDoc(id)).toMatchObject({ status: "cancelled", paymentStatus: "expired" });
    expect(await payDoc(id)).toMatchObject({ status: "expired" });
    expect((await eventDoc()).registeredCount).toBe(0);
    expect((await festDoc()).stats.registrations).toBe(0);
  });

  it("confirm instead of releasing when the provider shows the payment succeeded (lost webhook)", async () => {
    const id = await registerAndPay(a);
    await lapse(id);
    const swept = await expirePendingHolds();
    expect(swept).toMatchObject({ expired: 0, confirmed: 1 });
    expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
  });

  it("keep the hold while the provider cannot be reached, and release it once it is long overdue", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await checkout(a, id);
    await lapse(id);
    testProviderControl.setDown(true);
    expect(await expirePendingHolds()).toMatchObject({ expired: 0, skipped: 1 });
    expect((await regDoc(id)).status).toBe("pending_payment");
    await db().collection(COLLECTIONS.registrations).doc(id).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - 2 * 60 * 60 * 1000) });
    expect((await expirePendingHolds()).expired).toBe(1);
  });

  it("reinstate a payment that arrives late when the seat is still free", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await checkout(a, id);
    await lapse(id);
    await expirePendingHolds();
    expect((await eventDoc()).registeredCount).toBe(0);

    testProviderControl.settle(id, "paid");
    await paymentWebhook(id);
    expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect((await eventDoc()).registeredCount).toBe(1);
    expect(await emails(a.email, "registration_confirmed")).toBe(1);
  });

  it("refund a payment that arrives late when someone else took the seat", async () => {
    await seedPaidEvent({ capacity: 1 });
    const id = (await reg(a)).body.registration.id as string;
    await checkout(a, id);
    await lapse(id);
    await expirePendingHolds();
    expect((await reg(b)).status).toBe(201); // takes the freed seat

    testProviderControl.settle(id, "paid");
    await paymentWebhook(id);
    expect(await regDoc(id)).toMatchObject({ status: "cancelled", paymentStatus: "refunded" });
    expect(await payDoc(id)).toMatchObject({ status: "refunded" });
    expect(testProviderControl.order(id)!.refunds.size).toBe(1);
    expect(await emails(a.email, "registration_confirmed")).toBe(0);
    expect((await eventDoc()).registeredCount).toBe(1);
  });

  it("retry an automatic refund the provider could not take at first", async () => {
    await seedPaidEvent({ capacity: 1 });
    const id = (await reg(a)).body.registration.id as string;
    await checkout(a, id);
    await lapse(id);
    await expirePendingHolds();
    await reg(b);
    testProviderControl.settle(id, "paid");
    testProviderControl.setNextRefund("failed");
    await paymentWebhook(id);
    expect((await payDoc(id))!.status).toBe("refund_pending");

    testProviderControl.setNextRefund("success");
    // Not yet due: the failed attempt pushed the next one out on a back-off.
    expect(await retryAutoRefunds()).toBe(0);
    expect(await retryAutoRefunds({ now: Date.now() + 3 * 60 * 60_000 })).toBe(1);
    expect(await payDoc(id)).toMatchObject({ status: "refunded", openRefunds: false });
  });

  it("the cron endpoint is protected and runs the sweep", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await lapse(id);
    expect((await callRoute(cron, { path: "/api/cron/payments", method: "GET" })).status).toBe(401);
    expect((await callRoute(cron, { path: "/api/cron/payments", method: "GET", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const ok = await callRoute(cron, { path: "/api/cron/payments", method: "GET", headers: { authorization: "Bearer cron-secret-for-tests" } });
    expect(ok.status).toBe(200);
    expect(ok.body.holds.expired).toBe(1);
  });
});

/* ───────────── cancelling and refunds ───────────── */

describe("cancelling a paid registration", () => {
  it("drops an unpaid hold and frees the seat", async () => {
    const id = (await reg(a)).body.registration.id as string;
    expect((await cancelRegistration(a, id)).status).toBe(200);
    expect(await regDoc(id)).toMatchObject({ status: "cancelled", paymentStatus: "cancelled" });
    expect((await eventDoc()).registeredCount).toBe(0);
  });

  it("returns money paid after the entry was cancelled", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await checkout(a, id);
    await cancelRegistration(a, id);
    testProviderControl.settle(id, "paid");
    await paymentWebhook(id);
    expect(await regDoc(id)).toMatchObject({ status: "cancelled", paymentStatus: "refunded" });
    expect(await emails(a.email, "registration_confirmed")).toBe(0);
  });

  it("queues a refund for staff to approve instead of letting the student walk away from the payment", async () => {
    const id = await registerAndPay(a);
    await paymentWebhook(id);

    const res = await cancelRegistration(a, id);
    expect(res.status).toBe(200);
    expect(res.body.refundPending).toBe(true);
    expect(await regDoc(id)).toMatchObject({ status: "cancelled", paymentStatus: "refund_pending" });
    expect(await payDoc(id)).toMatchObject({ status: "refund_pending", openRefunds: true });
    expect((await payDoc(id))!.refunds[0]).toMatchObject({ amountPaise: 50000, reason: "student", autoRefund: false, status: "requested" });
    expect((await eventDoc()).registeredCount).toBe(0);
    // Not paid out on its own, and not by the automatic retry either.
    expect(await retryAutoRefunds()).toBe(0);
    expect(testProviderControl.order(id)!.refunds.size).toBe(0);

    // Only staff of this fest can approve it.
    const body = { action: "approve" };
    expect((await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: a.idToken, body })).status).toBe(403);
    expect((await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: otherAdmin.idToken, body })).status).toBe(403);
    expect((await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, body })).status).toBe(401);
    const approved = await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: admin.idToken, body });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(await regDoc(id)).toMatchObject({ paymentStatus: "refunded" });
    expect(await payDoc(id)).toMatchObject({ status: "refunded", openRefunds: false });
    expect(testProviderControl.order(id)!.refunds.size).toBe(1);
    expect(await noteTypes(a)).toContain("refund_update");

    // Approving again changes nothing and cannot refund twice.
    expect((await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: admin.idToken, body })).status).toBe(422);
    expect(testProviderControl.order(id)!.refunds.size).toBe(1);
  });

  it("staff cancelling a paid entry owes the same refund", async () => {
    const id = await registerAndPay(a);
    await paymentWebhook(id);
    const res = await callRoute(staffAction, { path: "/x", params: { id }, token: admin.idToken, body: { action: "cancel" } });
    expect(res.status).toBe(200);
    expect(await regDoc(id)).toMatchObject({ status: "cancelled", paymentStatus: "refund_pending" });
  });

  it("a refund that stays pending at the provider is finished by its webhook", async () => {
    const id = await registerAndPay(a);
    await paymentWebhook(id);
    await cancelRegistration(a, id);
    testProviderControl.setNextRefund("pending");
    await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: admin.idToken, body: { action: "approve" } });
    expect((await payDoc(id))!.refunds[0].status).toBe("pending");
    expect((await regDoc(id)).paymentStatus).toBe("refund_pending");

    const refundId = (await payDoc(id))!.refunds[0].id as string;
    // The webhook is only a hint: the refund is read back from the provider, so the provider has to have finished it.
    testProviderControl.settleRefund(id, refundId, "success");
    await send({ type: "refund", orderId: id, refundId, status: "success" });
    expect(await regDoc(id)).toMatchObject({ paymentStatus: "refunded" });
  });
});

/* ───────────── teams ───────────── */

describe("team registration with payment", () => {
  it("charges the team once, holds the roster, and sends the invitations only after payment", async () => {
    const created = await reg(a, { teamName: "Duo", members: [{ name: a.name, email: a.email }, { name: b.name, email: b.email }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.registration.id as string;
    expect(created.body.registration).toMatchObject({ status: "pending_payment", seats: 2, amountPaise: 50000 });
    expect((await eventDoc()).registeredCount).toBe(2);
    expect(await emails(b.email, "team_invite")).toBe(0);

    // The roster cannot be used to confirm an unpaid entry.
    const accept = await callRoute(team, { path: `/api/registrations/${id}/team`, token: b.idToken, params: { id }, body: { action: "accept" } });
    expect(accept.status).toBe(409);
    const invite = await callRoute(team, { path: `/api/registrations/${id}/team`, token: a.idToken, params: { id }, body: { action: "invite", member: { name: c.name, email: c.email } } });
    expect(invite.status).toBe(409);
    expect((await regDoc(id)).status).toBe("pending_payment");

    await checkout(a, id);
    testProviderControl.settle(id, "paid");
    await paymentWebhook(id);
    expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect(await emails(b.email, "team_invite")).toBe(1);
    expect(await emails(a.email, "registration_confirmed")).toBe(1);
  });

  it("a team still below its minimum becomes a draft once paid — and keeps its paid status", async () => {
    await seedPaidEvent({ teamSize: { min: 2, max: 3 } });
    const id = (await reg(a, { teamName: "Duo", members: [{ name: a.name, email: a.email }, { name: b.name, email: b.email }] })).body.registration.id as string;
    await checkout(a, id);
    testProviderControl.settle(id, "paid");
    await paymentWebhook(id);
    expect(await regDoc(id)).toMatchObject({ status: "draft", paymentStatus: "paid" });
    expect(await emails(a.email, "registration_confirmed")).toBe(0);
  });
});

/* ───────────── waitlists ───────────── */

describe("waitlist with payment", () => {
  it("never charges a waitlisted entry, and offers a payment hold — not a ticket — when promoted", async () => {
    await seedPaidEvent({ capacity: 1, waitlistEnabled: true });
    const first = (await reg(a)).body.registration.id as string;
    const waiting = await reg(b);
    expect(waiting.body.registration.status).toBe("waitlisted");
    expect(waiting.body.registration.paymentStatus).toBeUndefined();
    expect(await payDoc(waiting.body.registration.id)).toBeUndefined();
    expect((await checkout(b, waiting.body.registration.id)).status).toBe(409);

    const res = await cancelRegistration(a, first);
    expect(res.body.promoted).toBe(waiting.body.registration.id);
    const promoted = await regDoc(waiting.body.registration.id);
    expect(promoted).toMatchObject({ status: "pending_payment", paymentStatus: "pending", amountPaise: 50000 });
    expect(await payDoc(waiting.body.registration.id)).toMatchObject({ status: "created", amountPaise: 50000 });
    expect(await noteTypes(b)).toContain("payment_required");
    expect(await emails(b.email, "waitlist_promoted")).toBe(0);
    expect(await emails(b.email, "payment_due")).toBe(1);
    expect((await eventDoc()).registeredCount).toBe(1);

    // And the promoted person can now pay.
    await checkout(b, waiting.body.registration.id);
    testProviderControl.settle(waiting.body.registration.id, "paid");
    await paymentWebhook(waiting.body.registration.id);
    expect((await regDoc(waiting.body.registration.id)).status).toBe("confirmed");
  });

  it("an expired hold passes the seat to the next person in the queue", async () => {
    await seedPaidEvent({ capacity: 1, waitlistEnabled: true });
    const first = (await reg(a)).body.registration.id as string;
    const waiting = (await reg(b)).body.registration.id as string;
    await db().collection(COLLECTIONS.registrations).doc(first).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    await expirePendingHolds();
    expect(await regDoc(first)).toMatchObject({ status: "cancelled", paymentStatus: "expired" });
    expect(await regDoc(waiting)).toMatchObject({ status: "pending_payment" });
    expect((await eventDoc()).registeredCount).toBe(1);
  });

  it("staff promoting a waitlisted entry on a paid event starts a payment hold", async () => {
    await seedPaidEvent({ capacity: 1, waitlistEnabled: true });
    const first = (await reg(a)).body.registration.id as string;
    const waiting = (await reg(b)).body.registration.id as string;
    await db().collection(COLLECTIONS.events).doc("ev1").update({ capacity: 2 });
    expect(first).toBeTruthy();
    const res = await callRoute(staffAction, { path: "/x", params: { id: waiting }, token: admin.idToken, body: { action: "promote" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await regDoc(waiting)).toMatchObject({ status: "pending_payment", paymentStatus: "pending" });
    expect(await payDoc(waiting)).toBeDefined();
  });

  it("leaves a waitlisted entry waiting when the fest can no longer take payment", async () => {
    await seedPaidEvent({ capacity: 1, waitlistEnabled: true });
    const first = (await reg(a)).body.registration.id as string;
    const waiting = (await reg(b)).body.registration.id as string;
    await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").update({ status: "suspended" });
    const res = await cancelRegistration(a, first);
    expect(res.body.promoted).toBeNull();
    expect((await regDoc(waiting)).status).toBe("waitlisted");
  });
});

/* ───────────── organizer-side rules ───────────── */

describe("paid events (organizer)", () => {
  const newEvent = (over: Record<string, unknown> = {}) => ({
    festId: "fest1", slug: `paid-${(eventCounter += 1)}`, title: "Paid thing", category: "hackathon", venue: "Lab", date: "2026-09-26", startTime: "09:00", eventType: "solo", teamSize: { min: 1, max: 1 }, ...over,
  });
  const create = (body: Record<string, unknown>, user: TestUser = admin) => callRoute(createEvent, { path: "/api/admin/events", token: user.idToken, body });

  it("defaults to no online payment, and a fee alone does not turn it on", async () => {
    const res = await create(newEvent({ entryFee: 300 }));
    expect(res.status).toBe(201);
    expect(res.body.event.paymentEnabled).toBe(false);
  });

  it("will not publish a paid event until the fest has an approved payment account", async () => {
    await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").update({ status: "pending_review" });
    const refused = await create(newEvent({ entryFee: 300, paymentEnabled: true, status: "published" }));
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/payment account/);

    // A draft can be prepared in the meantime.
    expect((await create(newEvent({ entryFee: 300, paymentEnabled: true, status: "draft" }))).status).toBe(201);

    await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").update({ status: "active" });
    expect((await create(newEvent({ entryFee: 300, paymentEnabled: true, status: "published" }))).status).toBe(201);
  });

  it("requires a real fee, and refuses publishing while payments are switched off for the deployment", async () => {
    expect((await create(newEvent({ entryFee: 0, paymentEnabled: true }))).status).toBe(422);
    delete process.env.PAYMENTS_ENABLED;
    try {
      expect((await create(newEvent({ entryFee: 300, paymentEnabled: true, status: "published" }))).status).toBe(422);
    } finally {
      process.env.PAYMENTS_ENABLED = "1";
    }
  });

  it("publishing a draft paid event re-checks the account", async () => {
    const draft = await create(newEvent({ entryFee: 300, paymentEnabled: true, status: "draft" }));
    const id = draft.body.event.id as string;
    await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").update({ status: "suspended" });
    const publish = await callRoute(updateEvent, { method: "PATCH", path: `/api/admin/events/${id}`, params: { id }, token: admin.idToken, body: { status: "published" } });
    expect(publish.status).toBe(422);
  });

  it("locks the payment switch and the fee once anyone has registered", async () => {
    const id = (await reg(a)).body.registration.id as string;
    expect(id).toBeTruthy();
    const patch = (body: Record<string, unknown>) => callRoute(updateEvent, { method: "PATCH", path: "/api/admin/events/ev1", params: { id: "ev1" }, token: admin.idToken, body });
    expect((await patch({ paymentEnabled: false })).status).toBe(422);
    expect((await patch({ entryFee: 900 })).status).toBe(422);
    expect((await patch({ venue: "Hall 2" })).status).toBe(200); // unrelated edits still work
    expect((await eventDoc()).entryFee).toBe(500);
  });

  it("will not turn payment on for a free event that already has registrations", async () => {
    await seedEvent({ id: "free1", slug: "free1", entryFee: 0 });
    await db().collection(COLLECTIONS.registrations).doc("old").set({ id: "old", eventId: "free1", festId: "fest1", userId: a.uid, status: "confirmed", seats: 1, members: [], memberEmails: [], ticketCode: "PS-AAAAAAAAAA" });
    const res = await callRoute(updateEvent, { method: "PATCH", path: "/api/admin/events/free1", params: { id: "free1" }, token: admin.idToken, body: { paymentEnabled: true, entryFee: 200 } });
    expect(res.status).toBe(422);
  });

  it("cancelling a paid event releases unpaid holds and refunds every payment in full", async () => {
    const paid = await registerAndPay(a);
    await paymentWebhook(paid);
    const hold = (await reg(b)).body.registration.id as string;

    const res = await callRoute(updateEvent, { method: "PATCH", path: "/api/admin/events/ev1", params: { id: "ev1" }, token: admin.idToken, body: { status: "cancelled" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await regDoc(paid)).toMatchObject({ paymentStatus: "refunded" });
    expect(await payDoc(paid)).toMatchObject({ status: "refunded" });
    expect(testProviderControl.order(paid)!.refunds.size).toBe(1);
    expect(await regDoc(hold)).toMatchObject({ status: "cancelled", paymentStatus: "cancelled" });
    expect((await eventDoc()).registeredCount).toBe(1); // the paid entry's seat is not re-sold; the unpaid hold is gone
  });
});

/* ───────────── payment account ───────────── */

describe("the fest payment account", () => {
  const params = { id: "fest1" };
  const save = (user: TestUser, body: Record<string, unknown>) => callRoute(putPayments, { method: "PUT", path: "/api/admin/fests/fest1/payments", params, token: user.idToken, body });

  beforeEach(async () => {
    await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").delete();
    await db().collection(COLLECTIONS.paymentSecrets).doc("fest1").delete();
  });

  it("stores credentials encrypted, never returns them, and needs a platform administrator's approval", async () => {
    const secret = "whsec_super_secret_value_123";
    const res = await save(admin, { provider: "test", mode: "sandbox", merchantRef: "merchant-1", credentials: { webhookSecret: secret } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.account).toMatchObject({ status: "pending_review", credentialsSaved: true, provider: "test", mode: "sandbox", merchantRef: "merchant-1" });
    expect(res.body.available).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(secret);

    const stored = (await db().collection(COLLECTIONS.paymentSecrets).doc("fest1").get()).data()!;
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify((await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").get()).data())).not.toContain(secret);
    expect(JSON.stringify((await db().collection(COLLECTIONS.auditLog).get()).docs.map((d) => d.data()))).not.toContain(secret);

    const read = await callRoute(getPayments, { path: "/x", params, token: admin.idToken });
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(secret);

    // The fest's own admin cannot approve their own account.
    const selfApprove = await callRoute(reviewPayments, { path: "/x", params, token: admin.idToken, body: { action: "approve", expectedVersion: 1, confirmMerchantId: "test-merchant" } });
    expect(selfApprove.status).toBe(403);
    expect((await reg(a)).status).toBe(422); // still not usable

    const approved = await callRoute(reviewPayments, { path: "/x", params, token: superAdmin.idToken, body: { action: "approve", expectedVersion: res.body.account.credentialsVersion, confirmMerchantId: res.body.account.merchantId } });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.account.status).toBe("active");
    expect(approved.body.available).toBe(true);
    expect((await reg(a)).status).toBe(201);

    // Changing credentials sends the account back for review.
    const changed = await save(admin, { provider: "test", mode: "sandbox", credentials: { webhookSecret: "another_secret_value" } });
    expect(changed.body.account.status).toBe("pending_review");
    const suspended = await callRoute(reviewPayments, { path: "/x", params, token: superAdmin.idToken, body: { action: "suspend" } });
    expect(suspended.body.account.status).toBe("suspended");
  });

  it("validates what it accepts", async () => {
    expect((await save(admin, { provider: "test", mode: "live", credentials: { webhookSecret: "x" } })).status).toBe(422);
    expect((await save(admin, { provider: "nope", mode: "sandbox", credentials: { webhookSecret: "x" } })).status).toBe(400);
    expect((await save(admin, { provider: "test", mode: "sandbox", credentials: { webhookSecret: "x", extra: "y" } })).status).toBe(400);
    expect((await save(admin, { provider: "test", mode: "sandbox", credentials: {} })).status).toBe(400);
  });

  it("is limited to staff of this fest", async () => {
    const body = { provider: "test", mode: "sandbox", credentials: { webhookSecret: "x" } };
    expect((await callRoute(putPayments, { method: "PUT", path: "/x", params, body })).status).toBe(401);
    expect((await save(a, body)).status).toBe(403);
    expect((await save(otherAdmin, body)).status).toBe(403);
    expect((await callRoute(getPayments, { path: "/x", params, token: a.idToken })).status).toBe(403);
    expect((await callRoute(getPayments, { path: "/x", params, token: otherAdmin.idToken })).status).toBe(403);
    expect((await callRoute(reviewPayments, { path: "/x", params, token: a.idToken, body: { action: "approve", expectedVersion: 1, confirmMerchantId: "x" } })).status).toBe(403);
  });

  it("cannot store credentials when the encryption key is not configured", async () => {
    const key = process.env.PAYMENT_SECRET_KEY;
    delete process.env.PAYMENT_SECRET_KEY;
    try {
      const res = await save(admin, { provider: "test", mode: "sandbox", credentials: { webhookSecret: "whsec_long_enough_1" } });
      expect(res.status).toBe(503);
      expect((await db().collection(COLLECTIONS.paymentSecrets).doc("fest1").get()).exists).toBe(false);
    } finally {
      process.env.PAYMENT_SECRET_KEY = key;
    }
  });

  it("the test provider does not exist when it is not allowed", async () => {
    const save2 = async () => save(admin, { provider: "test", mode: "sandbox", credentials: { webhookSecret: "x" } });
    delete process.env.PAYMENTS_ALLOW_TEST_PROVIDER;
    try {
      expect((await save2()).status).toBe(422);
      expect((await send({ type: "payment", orderId: "x" })).status).toBe(404);
    } finally {
      process.env.PAYMENTS_ALLOW_TEST_PROVIDER = "1";
    }
  });
});

/* ───────────── the lifecycle itself ───────────── */

describe("applying a provider order", () => {
  it("ignores an order that does not belong to the registration", async () => {
    const id = (await reg(a)).body.registration.id as string;
    const outcome = await applyOrderSnapshot(id, { orderId: "someone-elses-order", status: "paid", amountPaise: 50000, currency: "INR" });
    expect(outcome.kind).toBe("noop");
    expect((await regDoc(id)).status).toBe("pending_payment");
  });

  it("leaves a confirmed free registration alone", async () => {
    await seedEvent();
    const created = await reg(a);
    const outcome = await applyOrderSnapshot(created.body.registration.id, { orderId: "x", status: "paid", amountPaise: 1, currency: "INR" });
    expect(outcome.kind).toBe("noop");
  });
});
