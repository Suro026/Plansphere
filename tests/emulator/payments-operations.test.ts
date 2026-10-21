import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminDb, COLLECTIONS, FieldValue, Timestamp } from "@/server/firebase-admin";
import { POST as register } from "@/app/api/registrations/route";
import { POST as cancel } from "@/app/api/registrations/[id]/cancel/route";
import { POST as startPayment } from "@/app/api/registrations/[id]/payment/route";
import { POST as webhook } from "@/app/api/payments/webhook/[provider]/route";
import { GET as cron } from "@/app/api/cron/payments/route";
import { GET as health } from "@/app/api/health/route";
import { POST as refundRoute } from "@/app/api/admin/payments/[registrationId]/refund/route";
import { GET as getPayments, PUT as putPayments, POST as reviewPayments } from "@/app/api/admin/fests/[id]/payments/route";
import { DELETE as deleteFest, PATCH as patchFest } from "@/app/api/admin/fests/[id]/route";
import { PATCH as updateEvent } from "@/app/api/admin/events/[id]/route";
import { GET as eventRefunds, POST as resumeEventRefunds } from "@/app/api/admin/events/[id]/refunds/route";
import * as lifecycle from "@/server/payments/lifecycle";
import { expirePendingHolds, handleEventCancelled, refundBackoffMs, REFUND_STUCK_AFTER_FAILURES, REFUND_STUCK_AFTER_POLLS, retryAutoRefunds } from "@/server/payments/lifecycle";
import { HEARTBEAT_ID, paymentsHealth, runPaymentsHousekeeping } from "@/server/payments/housekeeping";
import { encryptCredentials } from "@/server/payments/secrets";
import { testProviderControl } from "@/server/payments/providers/test-provider";
import { callRoute, eventDoc, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * Audit Stage 2: H2 (refunds for a cancelled event survive anything), H3 (who
 * may redirect payments, and how an approval is made) and H4 (the system
 * recovers from provider failures on its own and says when it cannot).
 * Route handlers + the Firestore emulator; the test provider only.
 */

const SECRET = "whsec_unit_test_only";
const ENV_KEYS = ["PAYMENTS_ENABLED", "PAYMENTS_LIVE_ENABLED", "PAYMENTS_ALLOW_TEST_PROVIDER", "PAYMENT_SECRET_KEY", "PAYMENT_SECRET_KEYS_PREVIOUS", "CRON_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};
const HOUR = 60 * 60_000;

let a: TestUser;
let b: TestUser;
let c: TestUser;
let owner: TestUser;
let coAdmin: TestUser;
let otherAdmin: TestUser;
let superAdmin: TestUser;
let superTwo: TestUser;

const db = () => adminDb();
const regDoc = async (id: string) => (await db().collection(COLLECTIONS.registrations).doc(id).get()).data()!;
const payDoc = async (id: string) => (await db().collection(COLLECTIONS.payments).doc(id).get()).data()!;
const accountDoc = async (festId = "fest1") => (await db().collection(COLLECTIONS.paymentAccounts).doc(festId).get()).data();
const noteTypes = async (user: TestUser) => (await db().collection(COLLECTIONS.notifications).where("userId", "==", user.uid).get()).docs.map((d) => d.data().type as string);

const seedAccount = async (over: Record<string, unknown> = {}, festId = "fest1") => {
  await db().collection(COLLECTIONS.paymentSecrets).doc(festId).set({ festId, blob: encryptCredentials({ webhookSecret: SECRET, merchantId: "m-1" }, festId), updatedAt: new Date() });
  await db().collection(COLLECTIONS.paymentAccounts).doc(festId).set({ festId, provider: "test", mode: "sandbox", status: "active", credentialsVersion: 1, merchantId: "m-1", merchantName: "Test merchant (m-1)", updatedBy: "someone-else", updatedAt: new Date(), ...over });
};

const reg = (user: TestUser) => callRoute(register, { path: "/api/registrations", token: user.idToken, body: { eventId: "ev1", teamName: `${user.name} solo`, members: [{ name: user.name, email: user.email }] } });
const checkout = (user: TestUser, id: string) => callRoute(startPayment, { path: "/x", token: user.idToken, params: { id }, body: {} });
const cancelReg = (user: TestUser, id: string) => callRoute(cancel, { path: "/x", token: user.idToken, params: { id }, body: {} });
let counter = 0;
const send = (body: Record<string, unknown>, secret = SECRET) => {
  const full = { eventId: `evt_o_${(counter += 1)}`, ...body };
  return callRoute(webhook, { path: "/api/payments/webhook/test", params: { provider: "test" }, body: full, headers: testProviderControl.signedWebhook(full, secret).headers });
};
const paidRegistration = async (user: TestUser) => {
  const id = (await reg(user)).body.registration.id as string;
  expect((await checkout(user, id)).status).toBe(200);
  testProviderControl.settle(id, "paid");
  await send({ type: "payment", orderId: id });
  expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
  return id;
};
const cancelEvent = (user: TestUser = owner) => callRoute(updateEvent, { method: "PATCH", path: "/x", params: { id: "ev1" }, token: user.idToken, body: { status: "cancelled" } });
const cronCall = () => callRoute(cron, { path: "/api/cron/payments", method: "GET", headers: { authorization: "Bearer cron-secret-for-tests" } });
const put = (user: TestUser | null, credentials: Record<string, string>, festId = "fest1") =>
  callRoute(putPayments, { method: "PUT", path: "/x", params: { id: festId }, ...(user ? { token: user.idToken } : {}), body: { provider: "test", mode: "sandbox", credentials } });
const approve = (user: TestUser, account: { credentialsVersion: number; merchantId: string }, festId = "fest1") =>
  callRoute(reviewPayments, { path: "/x", params: { id: festId }, token: user.idToken, body: { action: "approve", expectedVersion: account.credentialsVersion, confirmMerchantId: account.merchantId } });

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
  c = await mintUser({ name: "Chen" });
  owner = await mintUser({ role: "admin", festIds: ["fest1"], name: "Fest Owner" });
  coAdmin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Co Admin" });
  otherAdmin = await mintUser({ role: "admin", festIds: ["fest2"], name: "Other Admin" });
  superAdmin = await mintUser({ role: "super_admin", name: "Super One" });
  superTwo = await mintUser({ role: "super_admin", name: "Super Two" });
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
  vi.restoreAllMocks();
  for (const u of [a, b, c]) await db().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, fullName: u.name, name: u.name, role: "student", emailVerified: true, student: { college: "T" }, createdAt: new Date(), updatedAt: new Date() });
  const festsOf: Record<string, string[]> = { [owner.uid]: ["fest1"], [coAdmin.uid]: ["fest1"], [otherAdmin.uid]: ["fest2"] };
  for (const u of [owner, coAdmin, otherAdmin, superAdmin, superTwo]) {
    await db().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, name: u.name, role: u.role, festIds: festsOf[u.uid] ?? [], profileCompleted: true, createdAt: new Date(), updatedAt: new Date() });
  }
  await seedFest({ ownerId: owner.uid });
  await seedFest({ id: "fest2", slug: "other", name: "Other fest", ownerId: otherAdmin.uid });
  await seedAccount();
  await seedEvent({ entryFee: 500, paymentEnabled: true });
});

/* ───────────── H2 — refunds for a cancelled event are durable ───────────── */

describe("H2: cancelling a paid event", () => {
  it("records the obligation with the cancellation, and finishes it even when the provider is down", async () => {
    const paidA = await paidRegistration(a);
    const paidB = await paidRegistration(b);
    const hold = (await reg(c)).body.registration.id as string;

    testProviderControl.setDown(true);
    const res = await cancelEvent();
    expect(res.status, JSON.stringify(res.body)).toBe(200); // the cancellation stands whatever the provider is doing

    expect(await eventDoc()).toMatchObject({ status: "cancelled", refundsPending: true });
    // Records exist and nothing has been lost; the hold was released.
    for (const id of [paidA, paidB]) {
      const pay = await payDoc(id);
      expect(pay).toMatchObject({ status: "refund_pending", openRefunds: true });
      expect(pay.refunds[0]).toMatchObject({ reason: "event_cancelled", autoRefund: true, amountPaise: 50000 });
      expect(await regDoc(id)).toMatchObject({ paymentStatus: "refund_pending" });
    }
    expect(await regDoc(hold)).toMatchObject({ status: "cancelled", paymentStatus: "cancelled" });
    const status = await callRoute(eventRefunds, { method: "GET", path: "/x", params: { id: "ev1" }, token: owner.idToken });
    expect(status.body).toMatchObject({ refundsPending: true, remaining: 2 });

    // The provider comes back; the payments job finishes the work.
    testProviderControl.setDown(false);
    const run = await cronCall();
    expect(run.status).toBe(200);
    expect(run.body.errors).toEqual({});
    for (const id of [paidA, paidB]) {
      expect(await payDoc(id)).toMatchObject({ status: "refunded", openRefunds: false });
      expect(testProviderControl.order(id)!.refunds.size).toBe(1);
    }
    expect((await eventDoc()).refundsPending).toBeUndefined();
  });

  it("survives a cancellation that was cut short: only the event flag was written", async () => {
    const paidA = await paidRegistration(a);
    const paidB = await paidRegistration(b);
    // The request wrote the cancellation and the obligation, then died.
    await db().collection(COLLECTIONS.events).doc("ev1").update({ status: "cancelled", refundsPending: true });
    expect(await payDoc(paidA)).toMatchObject({ status: "paid" });

    const run = await runPaymentsHousekeeping();
    expect(run.errors).toEqual({});
    for (const id of [paidA, paidB]) expect(await payDoc(id)).toMatchObject({ status: "refunded" });
    expect((await eventDoc()).refundsPending).toBeUndefined();
  });

  it("is idempotent: running it again changes nothing and refunds nothing twice", async () => {
    const id = await paidRegistration(a);
    await cancelEvent();
    await runPaymentsHousekeeping();
    await runPaymentsHousekeeping();
    await handleEventCancelled("ev1");
    expect((await payDoc(id)).refunds).toHaveLength(1);
    expect(testProviderControl.order(id)!.refunds.size).toBe(1);
  });

  it("stops at its time budget with the work still marked, and the next run carries on", async () => {
    const id = await paidRegistration(a);
    await db().collection(COLLECTIONS.events).doc("ev1").update({ status: "cancelled", refundsPending: true });
    const partial = await handleEventCancelled("ev1", { budgetMs: -1 });
    expect(partial.remaining).toBeGreaterThan(0);
    expect((await eventDoc()).refundsPending).toBe(true);
    expect(await payDoc(id)).toMatchObject({ status: "paid" });
    expect((await handleEventCancelled("ev1")).remaining).toBe(0);
    expect(await payDoc(id)).toMatchObject({ status: "refunded" });
  });

  it("turns a refund that was waiting for staff into an automatic one", async () => {
    const id = await paidRegistration(a);
    await cancelReg(a, id); // student withdrew first: refund queued for approval
    expect((await payDoc(id)).refunds[0]).toMatchObject({ autoRefund: false, status: "requested" });
    await cancelEvent();
    expect(await payDoc(id)).toMatchObject({ status: "refunded" });
  });

  it("leaves a hold that is frozen for review to staff, and does not keep the sweep waiting for it", async () => {
    const hold = (await reg(a)).body.registration.id as string;
    await db().collection(COLLECTIONS.registrations).doc(hold).update({ paymentStatus: "needs_review" });
    await cancelEvent();
    expect(await regDoc(hold)).toMatchObject({ status: "pending_payment", paymentStatus: "needs_review" });
    expect((await eventDoc()).refundsPending).toBeUndefined();
  });

  it("never refunds anyone for an event that is not cancelled, even if a stale flag is left behind", async () => {
    const id = await paidRegistration(a);
    // Cancelled, then reinstated by staff; the flag was never cleared.
    await db().collection(COLLECTIONS.events).doc("ev1").update({ status: "published", refundsPending: true });
    const run = await runPaymentsHousekeeping();
    expect(run.errors).toEqual({});
    expect(await payDoc(id)).toMatchObject({ status: "paid", refunds: [] });
    expect(await regDoc(id)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect(testProviderControl.order(id)!.refunds.size).toBe(0);
    expect((await eventDoc()).refundsPending).toBeUndefined();
    // Nor does calling it directly.
    await db().collection(COLLECTIONS.events).doc("ev1").update({ refundsPending: true });
    expect(await handleEventCancelled("ev1")).toEqual({ released: 0, refunds: 0, remaining: 0 });
    expect(await payDoc(id)).toMatchObject({ status: "paid" });
  });

  it("does not keep retrying a refund that has given up, unless a person asks for the event's refunds to be resumed", async () => {
    const id = await paidRegistration(a);
    await db().collection(COLLECTIONS.events).doc("ev1").update({ status: "cancelled", refundsPending: true });
    testProviderControl.setDown(true);
    await runPaymentsHousekeeping(); // records the refund; the provider is down
    await db().collection(COLLECTIONS.payments).doc(id).update({ flags: ["refund_stuck"], refundFailures: REFUND_STUCK_AFTER_FAILURES, nextRefundAt: FieldValue.delete() });

    testProviderControl.setDown(false);
    const run = await runPaymentsHousekeeping();
    expect(run.errors).toEqual({});
    expect(await payDoc(id)).toMatchObject({ status: "refund_pending" }); // left alone: bounded
    expect((await eventDoc()).refundsPending).toBe(true); // still visible as outstanding

    const resumed = await callRoute(resumeEventRefunds, { path: "/x", params: { id: "ev1" }, token: owner.idToken, body: {} });
    expect(resumed.status).toBe(200);
    expect(await payDoc(id)).toMatchObject({ status: "refunded" });
    expect((await eventDoc()).refundsPending).toBeUndefined();
  });

  it("can be resumed by a person, and only by staff of that fest", async () => {
    const id = await paidRegistration(a);
    await db().collection(COLLECTIONS.events).doc("ev1").update({ status: "cancelled", refundsPending: true });
    const call = (user: TestUser | null, method: "GET" | "POST" = "POST") =>
      callRoute(method === "POST" ? resumeEventRefunds : eventRefunds, { method, path: "/x", params: { id: "ev1" }, ...(user ? { token: user.idToken } : {}), ...(method === "POST" ? { body: {} } : {}) });

    expect((await call(null)).status).toBe(401);
    expect((await call(a)).status).toBe(403);
    expect((await call(otherAdmin)).status).toBe(403);
    expect((await call(otherAdmin, "GET")).status).toBe(403);
    expect(await payDoc(id)).toMatchObject({ status: "paid" });

    const resumed = await call(owner);
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body).toMatchObject({ remaining: 0 });
    expect(await payDoc(id)).toMatchObject({ status: "refunded" });
  });

  it("refuses to resume refunds for an event that has not been cancelled", async () => {
    const res = await callRoute(resumeEventRefunds, { path: "/x", params: { id: "ev1" }, token: owner.idToken, body: {} });
    expect(res.status).toBe(422);
  });
});

/* ───────────── H4 — recovering from provider failures ───────────── */

describe("H4: back-off, isolation, and visibility", () => {
  const failRefund = async () => {
    const id = await paidRegistration(a);
    await cancelReg(a, id);
    testProviderControl.setDown(true);
    await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: owner.idToken, body: { action: "approve" } });
    return id;
  };

  it("retries a failing refund on a growing delay and flags it for a person after repeated failure", async () => {
    expect(refundBackoffMs(1)).toBe(2 * 60_000);
    expect(refundBackoffMs(2)).toBe(4 * 60_000);
    expect(refundBackoffMs(3)).toBe(8 * 60_000);
    expect(refundBackoffMs(50)).toBe(6 * HOUR);

    const id = await failRefund();
    let pay = await payDoc(id);
    expect(pay.refundFailures).toBe(1);
    const first = (pay.nextRefundAt as Timestamp).toMillis();
    expect(first).toBeGreaterThan(Date.now() + 60_000);
    expect(first).toBeLessThan(Date.now() + 5 * 60_000);

    // Not due: nothing is attempted.
    expect(await retryAutoRefunds()).toBe(0);
    expect((await payDoc(id)).refundFailures).toBe(1);

    let previous = first;
    for (let i = 2; i < REFUND_STUCK_AFTER_FAILURES; i += 1) {
      await retryAutoRefunds({ now: Date.now() + 24 * HOUR });
      pay = await payDoc(id);
      expect(pay.refundFailures).toBe(i);
      const next = (pay.nextRefundAt as Timestamp).toMillis();
      expect(next).toBeGreaterThanOrEqual(previous - 5000);
      // The delay never exceeds six hours.
      expect(next).toBeLessThanOrEqual(Date.now() + 6 * HOUR + 5000);
      previous = next;
    }

    // The tenth failure ends automatic retrying: flagged for a person and taken off the schedule.
    await retryAutoRefunds({ now: Date.now() + 24 * HOUR });
    pay = await payDoc(id);
    expect(pay.refundFailures).toBe(REFUND_STUCK_AFTER_FAILURES);
    expect(pay.flags).toContain("refund_stuck");
    expect(pay.nextRefundAt).toBeUndefined();
    expect(pay).toMatchObject({ status: "refund_pending", openRefunds: true });

    // Bounded: from here nothing is attempted on its own, however long we wait (and the provider is never asked).
    testProviderControl.setDown(false);
    expect(await retryAutoRefunds({ now: Date.now() + 1000 * HOUR })).toBe(0);
    expect(testProviderControl.order(id)!.refunds.size).toBe(0);
    expect((await payDoc(id)).refundFailures).toBe(REFUND_STUCK_AFTER_FAILURES);

    const report = await paymentsHealth();
    expect(report.ok).toBe(false);
    expect(report.stuckRefunds).toBe(1);
    expect(report.problems.join(" ")).toMatch(/need a person/);

    // A person restarts it ("Approve refund"): the flag and counters reset and it goes through.
    const approved = await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: owner.idToken, body: { action: "approve" } });
    expect(approved.status).toBe(200);
    expect(await payDoc(id)).toMatchObject({ status: "refunded", openRefunds: false, refundFailures: 0 });
    expect((await payDoc(id)).flags).not.toContain("refund_stuck");
    expect((await payDoc(id)).nextRefundAt).toBeUndefined();
    expect((await paymentsHealth()).stuckRefunds).toBe(0);
  });

  it("stops polling a refund that stays pending at the provider for a day", async () => {
    const id = await paidRegistration(a);
    await cancelReg(a, id);
    testProviderControl.setNextRefund("pending");
    await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: owner.idToken, body: { action: "approve" } });
    expect((await payDoc(id)).refundPolls).toBe(1);

    await db().collection(COLLECTIONS.payments).doc(id).update({ refundPolls: REFUND_STUCK_AFTER_POLLS - 1 });
    await retryAutoRefunds({ now: Date.now() + HOUR });
    const pay = await payDoc(id);
    expect(pay.flags).toContain("refund_stuck");
    expect(pay.nextRefundAt).toBeUndefined();
    expect(await retryAutoRefunds({ now: Date.now() + 100 * HOUR })).toBe(0);
  });

  it("does not let payments that keep failing starve the ones behind them", async () => {
    // Two refunds whose fest has credentials nobody can read, due first; one healthy refund due after them.
    await seedAccount({}, "fest-broken");
    await db().collection(COLLECTIONS.paymentSecrets).doc("fest-broken").delete();
    const stuckDoc = (id: string, dueMsAgo: number) => ({
      id, registrationId: id, festId: "fest-broken", eventId: "evx", userId: "u", provider: "test", mode: "sandbox", credentialsVersion: 1, merchantId: "m-1", orderId: id, orderIds: [id], amountPaise: 100, currency: "INR",
      status: "refund_pending", paidOrderId: id, openRefunds: true, nextRefundAt: Timestamp.fromMillis(Date.now() - dueMsAgo),
      refunds: [{ id: `${id}_r1`, orderId: id, amountPaise: 100, reason: "event_cancelled", autoRefund: true, status: "requested", requestedAt: Timestamp.now() }],
    });
    await db().collection(COLLECTIONS.payments).doc("brokenA").set(stuckDoc("brokenA", 3 * HOUR));
    await db().collection(COLLECTIONS.payments).doc("brokenB").set(stuckDoc("brokenB", 2 * HOUR));
    // And one whose payment record was lost entirely: skipped, but must not stay at the front.
    await db().collection(COLLECTIONS.payments).doc("brokenC").set({ ...stuckDoc("brokenC", 2.5 * HOUR), festId: "fest-gone" });

    const healthy = await paidRegistration(b);
    await cancelReg(b, healthy);
    await db().collection(COLLECTIONS.payments).doc(healthy).update({ refunds: (await payDoc(healthy)).refunds.map((r: object) => ({ ...r, autoRefund: true })), nextRefundAt: Timestamp.fromMillis(Date.now() - 60_000) });

    // Room for only three per run: the three broken ones go first and are pushed out...
    expect(await retryAutoRefunds({ limit: 3 })).toBe(0);
    for (const id of ["brokenA", "brokenB", "brokenC"]) expect((await payDoc(id)).nextRefundAt.toMillis()).toBeGreaterThan(Date.now());
    expect((await payDoc(healthy)).status).toBe("refund_pending");
    // ...so the next run reaches the healthy one.
    expect(await retryAutoRefunds({ limit: 3 })).toBe(1);
    expect(await payDoc(healthy)).toMatchObject({ status: "refunded" });
  });

  it("takes a payment off the schedule when only staff-approved refunds are waiting", async () => {
    const id = await paidRegistration(a);
    await cancelReg(a, id); // non-automatic: waits for staff
    expect((await payDoc(id)).nextRefundAt).toBeUndefined();
    await db().collection(COLLECTIONS.payments).doc(id).update({ nextRefundAt: Timestamp.fromMillis(Date.now() - HOUR) }); // mis-scheduled
    expect(await retryAutoRefunds()).toBe(0);
    expect((await payDoc(id)).nextRefundAt).toBeUndefined();
    expect(testProviderControl.order(id)!.refunds.size).toBe(0);
  });

  it("re-checks a refund the provider is still processing, until it is done", async () => {
    const id = await paidRegistration(a);
    await cancelReg(a, id);
    testProviderControl.setNextRefund("pending");
    await callRoute(refundRoute, { path: "/x", params: { registrationId: id }, token: owner.idToken, body: { action: "approve" } });
    expect((await payDoc(id)).refunds[0].status).toBe("pending");
    expect((await payDoc(id)).nextRefundAt.toMillis()).toBeGreaterThan(Date.now());

    testProviderControl.settleRefund(id, `${id}_r1`, "success"); // finished at the provider; the webhook never came
    expect(await retryAutoRefunds({ now: Date.now() + HOUR })).toBe(1);
    expect(await payDoc(id)).toMatchObject({ status: "refunded", openRefunds: false });
  });

  it("works through lapsed holds within a time budget and reports instead of throwing", async () => {
    const id = (await reg(a)).body.registration.id as string;
    await db().collection(COLLECTIONS.registrations).doc(id).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - 5000) });
    expect(await expirePendingHolds({ budgetMs: -1 })).toMatchObject({ expired: 0, errors: 0 });
    expect((await regDoc(id)).status).toBe("pending_payment");
    expect(await expirePendingHolds()).toMatchObject({ expired: 1, errors: 0 });
  });

  it("the job runs every step even when one fails, and says which", async () => {
    vi.spyOn(lifecycle, "retryAutoRefunds").mockRejectedValueOnce(new Error("boom"));
    const id = (await reg(a)).body.registration.id as string;
    await db().collection(COLLECTIONS.registrations).doc(id).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - 5000) });
    const run = await runPaymentsHousekeeping();
    expect(run.errors).toEqual({ refunds: "boom" });
    expect(run.refunds).toBeNull();
    expect(run.holds).toMatchObject({ expired: 1 }); // the later step still ran
    const beat = (await db().collection(COLLECTIONS.paymentEvents).doc(HEARTBEAT_ID).get()).data()!;
    expect(beat.runs).toBe(1);
    expect(beat.lastErrors).toEqual({ refunds: "boom" });
  });

  it("is authenticated, and leaves a heartbeat", async () => {
    expect((await callRoute(cron, { path: "/x", method: "GET" })).status).toBe(401);
    expect((await callRoute(cron, { path: "/x", method: "GET", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await callRoute(cron, { path: "/x", method: "GET", headers: { authorization: "Bearer cron-secret-for-tests-and-more" } })).status).toBe(401);
    const ok = await cronCall();
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ errors: {}, holds: { expired: 0 } });
    expect((await db().collection(COLLECTIONS.paymentEvents).doc(HEARTBEAT_ID).get()).data()).toMatchObject({ runs: 1 });
  });

  it("reports healthy when nothing is waiting, and unhealthy when holds sit unreleased and the job is not running", async () => {
    expect((await paymentsHealth()).ok).toBe(false); // payments are enabled and the job has never run
    await runPaymentsHousekeeping();
    expect(await paymentsHealth()).toMatchObject({ ok: true, enabled: true, overdueHolds: 0, openRefunds: 0 });

    const id = (await reg(a)).body.registration.id as string;
    await db().collection(COLLECTIONS.registrations).doc(id).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - HOUR) });
    await db().collection(COLLECTIONS.paymentEvents).doc(HEARTBEAT_ID).update({ lastRunAt: Timestamp.fromMillis(Date.now() - 3 * HOUR) });
    const sick = await paymentsHealth();
    expect(sick.ok).toBe(false);
    expect(sick).toMatchObject({ overdueHolds: 1 });
    expect(sick.problems.join(" ")).toMatch(/past their time/);

    await runPaymentsHousekeeping();
    expect(await paymentsHealth()).toMatchObject({ ok: true, overdueHolds: 0 });
  });

  it("reports a job that was never scheduled, and one that went stale — only once payments are enabled", async () => {
    // Enabled, never ran: probably not scheduled.
    const never = await paymentsHealth();
    expect(never).toMatchObject({ ok: false, enabled: true, jobStatus: "never_ran", lastRunAt: null, lastRunAgeMinutes: null });
    expect(never.problems.join(" ")).toMatch(/never run — it is probably not scheduled/);

    // Runs: healthy.
    await runPaymentsHousekeeping();
    expect(await paymentsHealth()).toMatchObject({ ok: true, jobStatus: "running", lastRunErrors: [] });

    // Went quiet with nothing waiting: still reported, because the job is expected at least hourly.
    await db().collection(COLLECTIONS.paymentEvents).doc(HEARTBEAT_ID).update({ lastRunAt: Timestamp.fromMillis(Date.now() - 3 * HOUR) });
    const stale = await paymentsHealth();
    expect(stale).toMatchObject({ ok: false, jobStatus: "stale", overdueHolds: 0 });
    expect(stale.problems.join(" ")).toMatch(/last ran 180 minutes ago.*unscheduled/);

    // Payments off and nothing waiting: a missing job is not a problem.
    const saved = process.env.PAYMENTS_ENABLED;
    delete process.env.PAYMENTS_ENABLED;
    try {
      expect(await paymentsHealth()).toMatchObject({ ok: true, enabled: false, jobStatus: "stale" });
      await db().collection(COLLECTIONS.paymentEvents).doc(HEARTBEAT_ID).delete();
      expect(await paymentsHealth()).toMatchObject({ ok: true, enabled: false, jobStatus: "never_ran" });
      // ...but a hold that nobody is releasing still is, whatever the flag says.
      process.env.PAYMENTS_ENABLED = "1";
      const id = (await reg(a)).body.registration.id as string;
      delete process.env.PAYMENTS_ENABLED;
      await db().collection(COLLECTIONS.registrations).doc(id).update({ holdExpiresAt: Timestamp.fromMillis(Date.now() - HOUR) });
      expect((await paymentsHealth()).problems.join(" ")).toMatch(/past their time/);
    } finally {
      if (saved !== undefined) process.env.PAYMENTS_ENABLED = saved;
      else process.env.PAYMENTS_ENABLED = "1";
    }
  });

  it("reports the steps that failed in the last run", async () => {
    vi.spyOn(lifecycle, "expirePendingHolds").mockRejectedValueOnce(new Error("boom"));
    await runPaymentsHousekeeping();
    const report = await paymentsHealth();
    expect(report).toMatchObject({ ok: false, jobStatus: "running", lastRunErrors: ["holds"] });
    expect(report.problems.join(" ")).toMatch(/errors in: holds/);
    vi.restoreAllMocks();
    await runPaymentsHousekeeping();
    expect(await paymentsHealth()).toMatchObject({ ok: true, lastRunErrors: [] });
  });

  it("gives every step a bounded share of the time budget, in the order that protects money first", async () => {
    const calls: Array<[string, number | undefined]> = [];
    const spy = <K extends "sweepCancelledEvents" | "retryAutoRefunds" | "expirePendingHolds" | "reconcilePendingPayments">(name: K, value: unknown) =>
      vi.spyOn(lifecycle, name).mockImplementation((async (arg?: { budgetMs?: number }) => {
        calls.push([name, arg?.budgetMs]);
        return value;
      }) as never);
    spy("sweepCancelledEvents", { events: 0, remaining: 0 });
    spy("retryAutoRefunds", 0);
    spy("expirePendingHolds", { expired: 0, confirmed: 0, skipped: 0, errors: 0 });
    spy("reconcilePendingPayments", 0);

    await runPaymentsHousekeeping({ budgetMs: 100_000 });
    expect(calls.map(([name]) => name)).toEqual(["sweepCancelledEvents", "retryAutoRefunds", "expirePendingHolds", "reconcilePendingPayments"]);
    for (const [name, budget] of calls) {
      expect(budget, name).toBeGreaterThan(0);
      expect(budget, name).toBeLessThanOrEqual(100_000);
    }
    // The early steps cannot use the whole budget: the later ones always get time.
    expect(calls[0]![1]!).toBeLessThanOrEqual(30_000);
    expect(calls[1]![1]!).toBeLessThanOrEqual(0.4 * 100_000);
    expect(calls[2]![1]!).toBeLessThanOrEqual(0.6 * 100_000);
  });

  it("shows up on /api/health for a platform administrator, and only as pass/fail for anyone else", async () => {
    await runPaymentsHousekeeping();
    const full = await callRoute(health, { method: "GET", path: "/api/health", token: superAdmin.idToken });
    expect(full.body.checks.payments).toMatchObject({ ok: true });
    expect(full.body.checks.payments.detail).toMatchObject({ enabled: true, overdueHolds: 0 });
    const anonymous = await callRoute(health, { method: "GET", path: "/api/health" });
    expect(anonymous.body.checks.payments).toEqual({ ok: true, ms: expect.any(Number) });
  });
});

/* ───────────── H3 — who may redirect payments ───────────── */

describe("H3: who may change where payments go", () => {
  it("lets only the fest owner or a platform administrator save credentials; other admins can look", async () => {
    expect((await put(coAdmin, { webhookSecret: "whsec_brand_new_1" })).status).toBe(403);
    expect((await put(otherAdmin, { webhookSecret: "whsec_brand_new_1" })).status).toBe(403);
    expect((await put(a, { webhookSecret: "whsec_brand_new_1" })).status).toBe(403);
    expect((await put(null, { webhookSecret: "whsec_brand_new_1" })).status).toBe(401);
    expect(await accountDoc()).toMatchObject({ credentialsVersion: 1 });

    const asCo = await callRoute(getPayments, { path: "/x", params: { id: "fest1" }, token: coAdmin.idToken });
    expect(asCo.status).toBe(200);
    expect(asCo.body).toMatchObject({ canConfigure: false, canApprove: false });
    expect((await callRoute(getPayments, { path: "/x", params: { id: "fest1" }, token: owner.idToken })).body).toMatchObject({ canConfigure: true, canApprove: false });
    expect((await callRoute(getPayments, { path: "/x", params: { id: "fest1" }, token: superAdmin.idToken })).body).toMatchObject({ canConfigure: true, canApprove: true });

    expect((await put(owner, { webhookSecret: "whsec_brand_new_1" })).status).toBe(200);
    expect((await put(superAdmin, { webhookSecret: "whsec_brand_new_2" })).status).toBe(200);
  });

  it("makes the approver name the exact version and merchant they reviewed", async () => {
    const saved = await put(owner, { webhookSecret: "whsec_brand_new_1", merchantId: "m-77" });
    const account = saved.body.account as { credentialsVersion: number; merchantId: string };
    expect(account).toMatchObject({ merchantId: "m-77", credentialsVersion: 2 });

    // The body must carry both.
    expect((await callRoute(reviewPayments, { path: "/x", params: { id: "fest1" }, token: superAdmin.idToken, body: { action: "approve" } })).status).toBe(400);
    // Wrong merchant.
    expect((await approve(superAdmin, { ...account, merchantId: "m-OTHER" })).status).toBe(409);
    // The owner (or anyone else on the fest) cannot approve.
    expect((await approve(owner, account)).status).toBe(403);

    // Credentials change between the approver opening the page and clicking.
    await put(owner, { webhookSecret: "whsec_brand_new_2", merchantId: "m-88" });
    const stale = await approve(superAdmin, account);
    expect(stale.status).toBe(409);
    expect(await accountDoc()).toMatchObject({ status: "pending_review", merchantId: "m-88" });

    const current = (await callRoute(getPayments, { path: "/x", params: { id: "fest1" }, token: superAdmin.idToken })).body.account;
    const done = await approve(superAdmin, current);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(await accountDoc()).toMatchObject({ status: "active", approvedVersion: 3, approvedBy: superAdmin.uid });
    const audit = (await db().collection(COLLECTIONS.auditLog).where("action", "==", "payment_account_approved").get()).docs.map((d) => d.data());
    expect(audit[0]!.details).toMatchObject({ version: 3, merchantId: "m-88" });
  });

  it("does not let the person who saved the credentials approve them", async () => {
    const saved = await put(superAdmin, { webhookSecret: "whsec_brand_new_1", merchantId: "m-5" });
    const view = await callRoute(getPayments, { path: "/x", params: { id: "fest1" }, token: superAdmin.idToken });
    expect(view.body.canApprove).toBe(false);
    expect((await approve(superAdmin, saved.body.account)).status).toBe(403);
    expect((await approve(superTwo, saved.body.account)).status).toBe(200);
    expect(await accountDoc()).toMatchObject({ status: "active", approvedBy: superTwo.uid });
  });

  it("will not approve an account the provider never identified", async () => {
    await db().collection(COLLECTIONS.paymentAccounts).doc("fest1").update({ status: "pending_review", merchantId: null, merchantName: null });
    const res = await callRoute(reviewPayments, { path: "/x", params: { id: "fest1" }, token: superAdmin.idToken, body: { action: "approve", expectedVersion: 1, confirmMerchantId: "m-1" } });
    expect(res.status).toBe(422);
    expect(await accountDoc()).toMatchObject({ status: "pending_review" });
  });

  it("tells the fest's other admins and the platform when the account changes — but not the person who did it", async () => {
    await put(owner, { webhookSecret: "whsec_brand_new_1", merchantId: "m-9" });
    expect(await noteTypes(coAdmin)).toContain("payment_account");
    expect(await noteTypes(superAdmin)).toContain("payment_account");
    expect(await noteTypes(superTwo)).toContain("payment_account");
    expect(await noteTypes(owner)).not.toContain("payment_account");
    expect(await noteTypes(otherAdmin)).not.toContain("payment_account"); // another fest's admin hears nothing
    expect(await noteTypes(a)).not.toContain("payment_account");

    const account = (await callRoute(getPayments, { path: "/x", params: { id: "fest1" }, token: superAdmin.idToken })).body.account;
    await approve(superAdmin, account);
    expect(await noteTypes(owner)).toContain("payment_account"); // told it was approved
  });

  it("suspends the payment account when ownership changes, and only the new owner can then set one up", async () => {
    expect(await accountDoc()).toMatchObject({ status: "active" });
    const transfer = await callRoute(patchFest, { method: "PATCH", path: "/x", params: { id: "fest1" }, token: superAdmin.idToken, body: { action: "transfer", ownerId: coAdmin.uid } });
    expect(transfer.status, JSON.stringify(transfer.body)).toBe(200);
    expect(await accountDoc()).toMatchObject({ status: "suspended", suspendedReason: "ownership_transferred" });
    expect((await db().collection(COLLECTIONS.auditLog).where("action", "==", "payment_account_suspended").get()).size).toBe(1);

    // New orders are refused until new credentials are approved.
    expect((await reg(a)).status).toBe(422);
    // The previous owner can no longer change the credentials; the new one can.
    expect((await put(owner, { webhookSecret: "whsec_brand_new_1" })).status).toBe(403);
    const saved = await put(coAdmin, { webhookSecret: "whsec_brand_new_2", merchantId: "m-new" });
    expect(saved.status).toBe(200);
    expect(saved.body.account.status).toBe("pending_review");
  });

  it("removes a fest's stored credentials when the fest is deleted", async () => {
    await seedFest({ id: "fest-empty", slug: "empty", name: "Empty", ownerId: owner.uid });
    await seedAccount({}, "fest-empty");
    const res = await callRoute(deleteFest, { method: "DELETE", path: "/x", params: { id: "fest-empty" }, token: superAdmin.idToken });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await db().collection(COLLECTIONS.paymentAccounts).doc("fest-empty").get()).exists).toBe(false);
    expect((await db().collection(COLLECTIONS.paymentSecrets).doc("fest-empty").get()).exists).toBe(false);
    // A fest that cannot be deleted keeps its account.
    expect((await callRoute(deleteFest, { method: "DELETE", path: "/x", params: { id: "fest1" }, token: superAdmin.idToken })).status).toBe(422);
    expect(await accountDoc()).toMatchObject({ status: "active" });
  });

  it("an admin of the fest who is not its owner cannot suspend, approve, or release anything either", async () => {
    expect((await callRoute(reviewPayments, { path: "/x", params: { id: "fest1" }, token: coAdmin.idToken, body: { action: "suspend" } })).status).toBe(403);
    expect((await callRoute(reviewPayments, { path: "/x", params: { id: "fest1" }, token: owner.idToken, body: { action: "suspend" } })).status).toBe(403);
    expect(await accountDoc()).toMatchObject({ status: "active" });
  });
});
