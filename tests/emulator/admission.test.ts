import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { POST as manualEntry } from "@/app/api/admin/attendance/manual/route";
import { GET as wallet } from "@/app/api/registrations/[id]/wallet/[platform]/route";
import { POST as register } from "@/app/api/registrations/route";
import { POST as teamAction } from "@/app/api/registrations/[id]/team/route";
import { lookupTicket } from "@/server/public-lookup";
import { callRoute, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * One admission rule, checked at every gate against the same table.
 *
 * The table is written out here a second time, independently of
 * `src/core/models/admission.ts`, so a change to either side that the other
 * does not follow fails a test: firestore.rules (`admissible()`), the manual
 * attendance route, the wallet route and the public ticket lookup all have to
 * agree with it. (Unit tests cover the shared function and the offline
 * scanner; the repository test covers the online scanner.)
 */

type Block = "cancelled" | "waitlisted" | "draft" | "unpaid" | "refunded" | null;

const STATUSES = [undefined, "confirmed", "draft", "waitlisted", "pending_payment", "cancelled"] as const;
const PAYMENTS = [undefined, "not_required", "pending", "failed", "paid", "expired", "cancelled", "needs_review", "refund_pending", "refunded"] as const;

const expected = (status: string | undefined, payment: string | undefined): Block => {
  if (status === "waitlisted") return "waitlisted";
  if (status === "draft") return "draft";
  if (status === "pending_payment") return "unpaid";
  if (status === "cancelled") return "cancelled";
  if (payment === undefined || payment === "not_required" || payment === "paid") return null;
  return payment === "refund_pending" || payment === "refunded" ? "refunded" : "unpaid";
};

const combos = STATUSES.flatMap((status) => PAYMENTS.map((payment) => ({ status, payment, block: expected(status, payment), key: `${status ?? "none"}__${payment ?? "none"}` })));

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
let n = 0;
/** A unique, valid ticket code: FF- plus ten characters from the ticket alphabet. */
const code = () => {
  n += 1;
  let rest = n;
  let tail = "";
  for (let i = 0; i < 7; i += 1) {
    tail = ALPHABET[rest % 32]! + tail;
    rest = Math.floor(rest / 32);
  }
  return `FF-ADM${tail}`;
};

/* ───────────── Firestore rules ───────────── */

let env: RulesTestEnvironment;
const [host = "127.0.0.1", port = "8080"] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");
const volunteer = { uid: "vol1", email: "vol1@plansphere.test", email_verified: true, role: "volunteer", festIds: ["fest1"] };

describe("firestore.rules — attendance and meals follow the admission table", () => {
  beforeAll(async () => {
    env = await initializeTestEnvironment({ projectId: process.env.GCLOUD_PROJECT ?? "plansphere-test", firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) } });
  });
  afterAll(() => env.cleanup());
  beforeEach(() => env.clearFirestore());

  const regDoc = (id: string, status: string | undefined, payment: string | undefined) => ({
    id, eventId: "ev1", festId: "fest1", userId: "stu1", type: "solo", seats: 1, ticketCode: "FF-AAAAAAAAAA", members: [], memberEmails: [],
    eventTitle: "CTF", userName: "S", userEmail: "s@x.test", createdAt: new Date(), updatedAt: new Date(),
    ...(status ? { status } : {}), ...(payment ? { paymentStatus: payment } : {}),
  });

  it("admits (and refuses) exactly what the table says, for every status × payment status", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      for (const c of combos) await setDoc(doc(ctx.firestore(), "registrations", c.key), regDoc(c.key, c.status, c.payment));
    });
    const db = env.authenticatedContext(volunteer.uid, { email: volunteer.email, email_verified: true, role: "volunteer", festIds: ["fest1"] }).firestore();
    const entry = (id: string) => ({ id, registrationId: id, eventId: "ev1", festId: "fest1", userId: "stu1", ticketCode: "FF-AAAAAAAAAA", scannedAt: new Date(), scannedBy: volunteer.uid, method: "qr", createdAt: new Date(), updatedAt: new Date() });
    const meal = (id: string) => ({ id: `${id}_lunch_1`, registrationId: id, eventId: "ev1", festId: "fest1", userId: "stu1", ticketCode: "FF-AAAAAAAAAA", mealType: "lunch", servedOn: "2026-09-26", serving: 1, collectedAt: new Date(), collectedBy: volunteer.uid, createdAt: new Date(), updatedAt: new Date() });

    for (const c of combos) {
      const verdict = c.block === null ? assertSucceeds : assertFails;
      await verdict(setDoc(doc(db, "attendance", c.key), entry(c.key)));
      await verdict(setDoc(doc(db, "foodCollections", `${c.key}_lunch_1`), meal(c.key)));
    }
  });

  it("refuses a scan for a registration that does not exist", async () => {
    const db = env.authenticatedContext(volunteer.uid, { email: volunteer.email, email_verified: true, role: "volunteer", festIds: ["fest1"] }).firestore();
    await assertFails(setDoc(doc(db, "attendance", "ghost"), { id: "ghost", registrationId: "ghost", eventId: "ev1", festId: "fest1", userId: "x", ticketCode: "FF-AAAAAAAAAA", scannedAt: new Date(), scannedBy: volunteer.uid, method: "qr", createdAt: new Date(), updatedAt: new Date() }));
  });
});

/* ───────────── the server's gates ───────────── */

let admin: TestUser;
let otherFestAdmin: TestUser;
let student: TestUser;
let mate: TestUser;

describe("server gates follow the admission table", () => {
  beforeAll(async () => {
    await resetAuth();
    admin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Gate Admin" });
    otherFestAdmin = await mintUser({ role: "admin", festIds: ["fest2"], name: "Other Admin" });
    student = await mintUser({ name: "Holder" });
    mate = await mintUser({ name: "Mate" });
  });

  beforeEach(async () => {
    await resetFirestore();
    for (const u of [admin, otherFestAdmin, student, mate]) {
      await adminDb().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, name: u.name, role: u.role, festIds: u.role === "admin" ? (u === admin ? ["fest1"] : ["fest2"]) : [], profileCompleted: true, createdAt: new Date(), updatedAt: new Date() });
    }
    await seedFest();
    await seedEvent();
  });

  const seedAll = async () => {
    const tickets = new Map<string, string>();
    for (const c of combos) {
      const ticketCode = code();
      tickets.set(c.key, ticketCode);
      await adminDb().collection(COLLECTIONS.registrations).doc(c.key).set({
        id: c.key, eventId: "ev1", festId: "fest1", userId: student.uid, type: "solo", seats: 1, ticketCode,
        members: [{ name: student.name, email: student.email, userId: student.uid, isLeader: true, inviteStatus: "accepted" }], memberEmails: [student.email],
        eventTitle: "Capture the Flag", userName: student.name, userEmail: student.email, createdAt: new Date(), updatedAt: new Date(),
        ...(c.status ? { status: c.status } : {}), ...(c.payment ? { paymentStatus: c.payment } : {}),
      });
    }
    return tickets;
  };

  it("manual attendance admits and refuses exactly what the table says", async () => {
    const tickets = await seedAll();
    for (const c of combos) {
      const res = await callRoute(manualEntry, { path: "/api/admin/attendance/manual", token: admin.idToken, body: { ticketCode: tickets.get(c.key), eventId: "ev1" } });
      const want = c.block === null ? "ok" : c.block === "refunded" ? "cancelled" : c.block;
      expect(res.status, c.key).toBe(200);
      expect(res.body.result, c.key).toBe(want);
    }
    // Only the admitted ones left a record.
    const admitted = combos.filter((c) => c.block === null).length;
    expect((await adminDb().collection(COLLECTIONS.attendance).get()).size).toBe(admitted);
  });

  it("a team stays inadmissible while it assembles — free or paid — and is admitted the moment it is confirmed", async () => {
    await seedEvent({ eventType: "team", teamSize: { min: 2, max: 3 }, capacity: 10, entryFee: 0 });
    const created = await callRoute(register, { path: "/api/registrations", token: student.idToken, body: { eventId: "ev1", teamName: "Duo", members: [{ name: student.name, email: student.email }, { name: mate.name, email: mate.email }] } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { id, ticketCode } = created.body.registration as { id: string; ticketCode: string };
    expect(created.body.registration.status).toBe("draft");

    const scan = () => callRoute(manualEntry, { path: "/api/admin/attendance/manual", token: admin.idToken, body: { ticketCode, eventId: "ev1" } });
    expect((await scan()).body.result).toBe("draft");
    expect((await callRoute(wallet, { method: "GET", path: "/x", token: student.idToken, params: { id, platform: "apple" } })).status).toBe(422);
    expect((await lookupTicket(ticketCode)).ticket?.block).toBe("draft");
    expect((await adminDb().collection(COLLECTIONS.attendance).get()).size).toBe(0);

    // The workflow is unchanged: the invited teammate accepts, the team completes, the entry is confirmed.
    const respond = (action: "accept" | "decline") => callRoute(teamAction, { path: `/x/${id}/team`, token: mate.idToken, params: { id }, body: { action } });
    const accepted = await respond("accept");
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.registration.status).toBe("confirmed");
    expect((await lookupTicket(ticketCode)).ticket?.block).toBeNull();
    expect((await callRoute(wallet, { method: "GET", path: "/x", token: student.idToken, params: { id, platform: "apple" } })).status).not.toBe(422);

    // If the team falls below its minimum again it goes back to inadmissible...
    const left = await respond("decline");
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(left.body.registration.status).toBe("draft");
    expect((await scan()).body.result).toBe("draft");

    // ...and a confirmed team is admitted at the gate.
    const rejoined = await callRoute(teamAction, { path: `/x/${id}/team`, token: student.idToken, params: { id }, body: { action: "invite", member: { name: mate.name, email: mate.email } } });
    expect(rejoined.status, JSON.stringify(rejoined.body)).toBe(200);
    expect((await respond("accept")).body.registration.status).toBe("confirmed");
    expect((await scan()).body.result).toBe("ok");
    expect((await adminDb().collection(COLLECTIONS.attendance).get()).size).toBe(1);
  });

  it("manual attendance is refused for staff of another fest", async () => {
    const tickets = await seedAll();
    const res = await callRoute(manualEntry, { path: "/api/admin/attendance/manual", token: otherFestAdmin.idToken, body: { ticketCode: tickets.get("confirmed__paid"), eventId: "ev1" } });
    expect(res.status).toBe(403);
    expect((await callRoute(manualEntry, { path: "/x", body: { ticketCode: "FF-AAAAAAAAAA", eventId: "ev1" } })).status).toBe(401);
  });

  it("wallet passes are issued only to entries the gate would admit", async () => {
    await seedAll();
    for (const c of combos) {
      const res = await callRoute(wallet, { method: "GET", path: `/api/registrations/${c.key}/wallet/apple`, token: student.idToken, params: { id: c.key, platform: "apple" } });
      if (c.block === null) expect(res.status, c.key).not.toBe(422);
      else expect(res.status, c.key).toBe(422);
    }
  });

  it("the public ticket page's lookup reports the same block", async () => {
    const tickets = await seedAll();
    for (const c of combos) {
      const { ticket } = await lookupTicket(tickets.get(c.key)!);
      expect(ticket?.block, c.key).toBe(c.block);
    }
  });
});
