import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

/**
 * The volunteer's boundary, exercised against the real firestore.rules —
 * the spec's "enforce in rules, not only UI" as an actual test, not a
 * comment. A volunteer's screens never attempt the writes or reads below;
 * these prove the rules refuse them even if a screen tried. Scanning itself
 * is a server action (see volunteer-gate-api.test.ts): a volunteer's phone
 * neither reads the registrations nor writes the check-in.
 */

let env: RulesTestEnvironment;
const [host = "127.0.0.1", port = "8080"] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");

const volunteer = { uid: "vol1", email: "vol1@plansphere.test", email_verified: true, role: "volunteer", festIds: ["fest1"] };
const otherVolunteer = { uid: "vol2", email: "vol2@plansphere.test", email_verified: true, role: "volunteer", festIds: ["fest2"] };
const student = { uid: "stu1", email: "stu1@plansphere.test", email_verified: true, role: "student", festIds: [] as string[] };
const admin = { uid: "adm1", email: "adm1@plansphere.test", email_verified: true, role: "admin", festIds: ["fest1"] };

const as = (claims: { uid: string } & Record<string, unknown>) => {
  const { uid, ...token } = claims;
  return env.authenticatedContext(uid, token).firestore();
};

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: process.env.GCLOUD_PROJECT ?? "plansphere-test",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host, port: Number(port) },
  });
});
afterAll(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const now = new Date();
    await setDoc(doc(db, "fests", "fest1"), { id: "fest1", slug: "f1", name: "F1", status: "published", organizationName: "T", startDate: "2026-09-25", endDate: "2026-09-27", stats: { events: 0, registrations: 0, checkIns: 0 }, createdAt: now, updatedAt: now });
    await setDoc(doc(db, "registrations", "reg1"), {
      id: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid, type: "team", teamName: "NP", status: "confirmed", seats: 2, ticketCode: "FF-7K2M9QX4TB",
      members: [
        { name: "S", email: student.email, userId: student.uid, isLeader: true, inviteStatus: "accepted" },
        { name: "Mate", email: "mate@plansphere.test", isLeader: false, inviteStatus: "accepted" },
      ],
      memberEmails: [student.email, "mate@plansphere.test"], eventTitle: "CTF", userName: "S", userEmail: student.email, createdAt: now, updatedAt: now,
    });
    await setDoc(doc(db, "certificates", "ev1_stu1"), {
      id: "ev1_stu1", userId: student.uid, eventId: "ev1", festId: "fest1", registrationId: "reg1", certificateNumber: "FF-2026-ABCDEFGH", type: "participation",
      recipientName: "S", recipientEmail: student.email, eventTitle: "CTF", festName: "F1", revoked: false, published: true,
      delivery: { status: "sent", attempts: 1 }, issuedAt: now, issuedBy: admin.uid, createdAt: now, updatedAt: now,
    });
    await setDoc(doc(db, "auditLog", "a1"), { action: "event_updated", actorId: admin.uid, festId: "fest1", summary: "x", createdAt: now });
    await setDoc(doc(db, "emailLog", "e1"), { to: student.email, template: "registration_confirmed", status: "sent", festId: "fest1", createdAt: now });
  });
});

describe("what a volunteer may write", () => {
  it("writes no check-in and no meal from the client: the server records them after checking the duty and the competition", async () => {
    const record = { id: "reg1", registrationId: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid, ticketCode: "FF-7K2M9QX4TB", members: [{ key: "aaa11111", name: "S", email: student.email, at: new Date() }], memberCount: 2, scannedAt: new Date(), scannedBy: volunteer.uid, method: "qr", createdAt: new Date(), updatedAt: new Date() };
    await assertFails(setDoc(doc(as(volunteer), "attendance", "reg1"), record));
    await assertFails(setDoc(doc(as(otherVolunteer), "attendance", "reg2"), { ...record, id: "reg2", registrationId: "reg2", scannedBy: otherVolunteer.uid }));
  });

  it("cannot extend or rewrite an existing check-in either", async () => {
    const vol = as(volunteer);
    const base = { id: "reg1", registrationId: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid, ticketCode: "FF-7K2M9QX4TB", members: [{ key: "aaa11111", name: "S", email: student.email, at: new Date() }], memberCount: 2, scannedAt: new Date(), scannedBy: volunteer.uid, method: "qr", createdAt: new Date(), updatedAt: new Date() };
    await env.withSecurityRulesDisabled(async (ctx) => setDoc(doc(ctx.firestore(), "attendance", "reg1"), base));

    await assertFails(updateDoc(doc(vol, "attendance", "reg1"), { members: [...base.members, { key: "bbb22222", name: "Mate", email: "mate@plansphere.test", at: new Date() }], updatedAt: new Date() }));
    await assertFails(updateDoc(doc(vol, "attendance", "reg1"), { members: [], updatedAt: new Date() }));
    await assertFails(updateDoc(doc(vol, "attendance", "reg1"), { scannedBy: "someone-else", updatedAt: new Date() }));
    await assertFails(updateDoc(doc(vol, "attendance", "reg1"), { festId: "fest2", updatedAt: new Date() }));
  });

  it("writes no meal record from the client", async () => {
    const vol = as(volunteer);
    const doc1 = { id: "reg1_2026-09-26_lunch_aaa11111", registrationId: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid, ticketCode: "FF-7K2M9QX4TB", mealType: "lunch", servedOn: "2026-09-26", serving: 1, memberKey: "aaa11111", memberName: "S", collectedAt: new Date(), collectedBy: volunteer.uid, createdAt: new Date(), updatedAt: new Date() };
    await assertFails(setDoc(doc(vol, "foodCollections", doc1.id), doc1));
    await assertFails(setDoc(doc(vol, "foodCollections", "reg1_2026-09-26_lunch_bbb22222"), { ...doc1, id: "reg1_2026-09-26_lunch_bbb22222", memberKey: "bbb22222", memberName: "Mate" }));
  });
});

describe("what a volunteer may not write", () => {
  it("cannot edit a registration — not even to add themselves as a member", async () => {
    await assertFails(updateDoc(doc(as(volunteer), "registrations", "reg1"), { teamName: "Hijacked" }));
    await assertFails(updateDoc(doc(as(volunteer), "registrations", "reg1"), { status: "cancelled" }));
  });

  it("cannot touch the audit trail or the email log", async () => {
    await assertFails(setDoc(doc(as(volunteer), "auditLog", "a2"), { action: "x" }));
    await assertFails(setDoc(doc(as(volunteer), "emailLog", "e2"), { to: "x" }));
  });

  it("cannot delete an attendance record — undoing a synced scan is an admin action", async () => {
    await env.withSecurityRulesDisabled(async (ctx) =>
      setDoc(doc(ctx.firestore(), "attendance", "reg1"), { id: "reg1", registrationId: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid, ticketCode: "FF-7K2M9QX4TB", scannedAt: new Date(), scannedBy: volunteer.uid, createdAt: new Date(), updatedAt: new Date() }),
    );
    const { deleteDoc } = await import("firebase/firestore");
    await assertFails(deleteDoc(doc(as(volunteer), "attendance", "reg1")));
    await assertSucceeds(deleteDoc(doc(as(admin), "attendance", "reg1")));
  });

  it("cannot create or edit a fest, not even its public counters (a scan bumps them on the server)", async () => {
    await assertFails(setDoc(doc(as(volunteer), "fests", "fest2"), { id: "fest2", slug: "f2", name: "New", status: "draft", organizationName: "T", startDate: "2026-01-01", endDate: "2026-01-02", stats: { events: 0, registrations: 0, checkIns: 0 }, createdAt: new Date(), updatedAt: new Date() }));
    await assertFails(updateDoc(doc(as(volunteer), "fests", "fest1"), { name: "Renamed" }));
    await assertFails(updateDoc(doc(as(volunteer), "fests", "fest1"), { stats: { events: 0, registrations: 0, checkIns: 1 } }));
  });
});

describe("what a volunteer may read", () => {
  it("reads their own fest's public pages, and no registration: the gate roster comes from the server", async () => {
    await assertSucceeds(getDoc(doc(as(volunteer), "fests", "fest1")));
    await assertFails(getDoc(doc(as(volunteer), "registrations", "reg1")));
    await assertFails(getDocs(query(collection(as(volunteer), "registrations"), where("festId", "==", "fest1"))));
    await assertSucceeds(getDoc(doc(as(admin), "registrations", "reg1")));
  });
});

describe("what a volunteer may not read", () => {
  it("cannot read certificates — issuing and reviewing them is admin+", async () => {
    await assertFails(getDoc(doc(as(volunteer), "certificates", "ev1_stu1")));
    await assertFails(getDocs(query(collection(as(volunteer), "certificates"), where("festId", "==", "fest1"))));
    // An admin at the same fest can.
    await assertSucceeds(getDoc(doc(as(admin), "certificates", "ev1_stu1")));
  });

  it("cannot read the audit trail or the email log", async () => {
    await assertFails(getDocs(query(collection(as(volunteer), "auditLog"), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(collection(as(volunteer), "emailLog"), where("festId", "==", "fest1"))));
  });

  it("cannot read a registration outside their own fest", async () => {
    await assertFails(getDoc(doc(as(otherVolunteer), "registrations", "reg1")));
  });
});
