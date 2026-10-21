import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * firestore.rules, exercised the way a client would exercise them.
 *
 * Roles come from token claims exactly as in production; documents are
 * seeded with rules disabled, then read and written under each identity.
 */

let env: RulesTestEnvironment;
const [host = "127.0.0.1", port = "8080"] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");

const student = { uid: "stu1", email: "stu1@plansphere.test", email_verified: true, role: "student", festIds: [] as string[] };
const mate = { uid: "stu2", email: "stu2@plansphere.test", email_verified: true, role: "student", festIds: [] as string[] };
const stranger = { uid: "stu3", email: "stu3@plansphere.test", email_verified: true, role: "student", festIds: [] as string[] };
const volunteer = { uid: "org1", email: "org1@plansphere.test", email_verified: true, role: "volunteer", festIds: ["fest1"] };
const otherVolunteer = { uid: "org2", email: "org2@plansphere.test", email_verified: true, role: "volunteer", festIds: ["fest2"] };
const admin = { uid: "adm1", email: "adm1@plansphere.test", email_verified: true, role: "admin", festIds: ["fest1"] };
const otherAdmin = { uid: "adm2", email: "adm2@plansphere.test", email_verified: true, role: "admin", festIds: ["fest2"] };

const as = (claims: { uid: string } & Record<string, unknown>) => {
  const { uid, ...token } = claims;
  return env.authenticatedContext(uid, token).firestore();
};
const anon = () => env.unauthenticatedContext().firestore();

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
    await setDoc(doc(db, "users", student.uid), { id: student.uid, email: student.email, name: "Stu One", role: "student", disabled: false, createdAt: now, updatedAt: now });
    await setDoc(doc(db, "fests", "fest1"), { id: "fest1", slug: "bits2bytes", name: "Bits2Bytes", status: "published", organizationName: "T", startDate: "2026-09-25", endDate: "2026-09-27", stats: { events: 1, registrations: 0, checkIns: 0 }, createdAt: now, updatedAt: now });
    await setDoc(doc(db, "fests", "draft"), { id: "draft", slug: "secret", name: "Secret", status: "draft", organizationName: "T", startDate: "2026-10-01", endDate: "2026-10-02", stats: { events: 0, registrations: 0, checkIns: 0 }, createdAt: now, updatedAt: now });
    await setDoc(doc(db, "events", "ev1"), { id: "ev1", festId: "fest1", slug: "ctf", title: "CTF", status: "published", eventType: "team", capacity: 10, registeredCount: 1, createdAt: now, updatedAt: now });
    await setDoc(doc(db, "registrations", "reg1"), {
      id: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid, type: "team", teamName: "NP", status: "confirmed", seats: 2, ticketCode: "FF-7K2M9QX4TB",
      members: [{ name: "Stu One", email: student.email, userId: student.uid, isLeader: true, inviteStatus: "accepted" }, { name: "Stu Two", email: mate.email, isLeader: false, inviteStatus: "pending" }],
      memberEmails: [student.email, mate.email], eventTitle: "CTF", userName: "Stu One", userEmail: student.email, createdAt: now, updatedAt: now,
    });
    await setDoc(doc(db, "attendance", "reg1"), { id: "reg1", registrationId: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid, ticketCode: "FF-7K2M9QX4TB", scannedAt: now, scannedBy: volunteer.uid, method: "qr", createdAt: now, updatedAt: now });
    await setDoc(doc(db, "notifications", "n1"), { id: "n1", userId: student.uid, type: "team_invite", title: "Hi", body: "", read: false, createdAt: now, updatedAt: now });
    await setDoc(doc(db, "certificates", "ev1_stu1"), { id: "ev1_stu1", userId: student.uid, eventId: "ev1", festId: "fest1", registrationId: "reg1", certificateNumber: "FF-2026-ABCDEFGH", type: "participation", recipientName: "Stu One", recipientEmail: student.email, eventTitle: "CTF", festName: "Bits2Bytes", revoked: false, delivery: { status: "sent", attempts: 1 }, issuedAt: now, issuedBy: admin.uid, createdAt: now, updatedAt: now });
    await setDoc(doc(db, "emailLog", "e1"), { to: student.email, template: "registration_confirmed", status: "sent", festId: "fest1", createdAt: now });
    await setDoc(doc(db, "auditLog", "a1"), { action: "event_updated", actorId: admin.uid, festId: "fest1", summary: "x", createdAt: now });
    await setDoc(doc(db, "arenas", "arena1"), { id: "arena1", festId: "fest1", name: "Arena A", active: true, createdBy: admin.uid, createdAt: now, updatedAt: now });
    await setDoc(doc(db, "matches", "match1"), {
      id: "match1", festId: "fest1", eventId: "ev1", round: 1, roundLabel: "Final", matchIndex: 0, arenaId: "arena1",
      homeTeam: { name: "Alpha", isBye: false }, awayTeam: { name: "Beta", isBye: false }, status: "live", paused: false,
      sportType: "football", matchConfig: { durationType: "time", maxPlayers: 11 }, score: { home: 0, away: 0, detail: {}, displayHome: "0", displayAway: "0", isComplete: false },
      createdBy: admin.uid, createdAt: now, updatedAt: now,
    });
    await setDoc(doc(db, "matchLog", "log1"), { id: "log1", matchId: "match1", festId: "fest1", eventId: "ev1", type: "goal", side: "home", label: "Goal", undone: false, at: now, createdBy: volunteer.uid });
  });
});

describe("users", () => {
  it("a student reads and edits their own profile but cannot change their role", async () => {
    const db = as(student);
    await assertSucceeds(getDoc(doc(db, "users", student.uid)));
    await assertSucceeds(updateDoc(doc(db, "users", student.uid), { name: "Renamed", updatedAt: new Date() }));
    await assertFails(updateDoc(doc(db, "users", student.uid), { role: "super_admin", updatedAt: new Date() }));
  });
  it("another student cannot read the profile; staff can", async () => {
    await assertFails(getDoc(doc(as(stranger), "users", student.uid)));
    await assertSucceeds(getDoc(doc(as(admin), "users", student.uid)));
  });
});

describe("fests and events (public catalogue)", () => {
  it("anyone reads published fests by slug, nobody reads drafts anonymously", async () => {
    await assertSucceeds(getDocs(query(collection(anon(), "fests"), where("slug", "==", "bits2bytes"), where("status", "==", "published"))));
    await assertFails(getDoc(doc(anon(), "fests", "draft")));
    await assertSucceeds(getDoc(doc(as(admin), "fests", "draft")));
  });
  it("events are never written from a client, even by an admin", async () => {
    await assertFails(setDoc(doc(as(admin), "events", "ev9"), { title: "Rogue", festId: "fest1" }));
    await assertFails(updateDoc(doc(as(volunteer), "events", "ev1"), { capacity: 9999 }));
  });
});

describe("registrations", () => {
  it("the owner and a named teammate can read the entry; a stranger cannot", async () => {
    await assertSucceeds(getDoc(doc(as(student), "registrations", "reg1")));
    await assertSucceeds(getDoc(doc(as(mate), "registrations", "reg1")));
    await assertFails(getDoc(doc(as(stranger), "registrations", "reg1")));
    await assertFails(getDoc(doc(anon(), "registrations", "reg1")));
  });
  it("list queries are provable only when scoped to the caller", async () => {
    await assertSucceeds(getDocs(query(collection(as(student), "registrations"), where("userId", "==", student.uid))));
    await assertSucceeds(getDocs(query(collection(as(mate), "registrations"), where("memberEmails", "array-contains", mate.email))));
    await assertFails(getDocs(query(collection(as(stranger), "registrations"), where("memberEmails", "array-contains", mate.email))));
    await assertFails(getDocs(collection(as(student), "registrations")));
  });
  it("staff read within their fest only", async () => {
    await assertSucceeds(getDoc(doc(as(volunteer), "registrations", "reg1")));
    await assertFails(getDoc(doc(as(otherVolunteer), "registrations", "reg1")));
    await assertSucceeds(getDocs(query(collection(as(volunteer), "registrations"), where("festId", "==", "fest1"))));
  });
  it("clients never create registrations, and the owner may only cancel", async () => {
    await assertFails(setDoc(doc(as(student), "registrations", "forged"), { userId: student.uid, eventId: "ev1", festId: "fest1", status: "confirmed" }));
    await assertFails(updateDoc(doc(as(student), "registrations", "reg1"), { seats: 50, updatedAt: new Date() }));
    await assertFails(updateDoc(doc(as(mate), "registrations", "reg1"), { status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() }));
    await assertSucceeds(updateDoc(doc(as(student), "registrations", "reg1"), { status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() }));
  });
});

describe("attendance", () => {
  it("is readable by the holder, a teammate, and fest staff; never written by clients", async () => {
    await assertSucceeds(getDoc(doc(as(student), "attendance", "reg1")));
    await assertSucceeds(getDoc(doc(as(mate), "attendance", "reg1")));
    await assertSucceeds(getDoc(doc(as(volunteer), "attendance", "reg1")));
    await assertFails(getDoc(doc(as(stranger), "attendance", "reg1")));
    await assertFails(setDoc(doc(as(volunteer), "attendance", "reg2"), { registrationId: "reg2", eventId: "ev1", festId: "fest1", userId: "x" }));
  });
  it("staff may read a not-yet-existing record (the scan transaction's first step); students may not", async () => {
    await assertSucceeds(getDoc(doc(as(volunteer), "attendance", "reg-new")));
    await assertSucceeds(getDoc(doc(as(volunteer), "foodCollections", "reg-new_2026-09-26_lunch_1")));
    await assertFails(getDoc(doc(as(student), "attendance", "reg-new")));
    await assertFails(getDoc(doc(as(otherVolunteer), "attendance", "reg1")));
  });
  it("an volunteer records a scan for their fest exactly once", async () => {
    const db = as(volunteer);
    // A scan is only ever recorded for a registration that exists (the admission rule reads it).
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "registrations", "reg2"), { id: "reg2", eventId: "ev1", festId: "fest1", userId: student.uid, type: "solo", status: "confirmed", seats: 1, ticketCode: "FF-AAAAAAAAAA", members: [], memberEmails: [], eventTitle: "CTF", userName: "S", userEmail: student.email, createdAt: new Date(), updatedAt: new Date() });
    });
    const record = { id: "reg2", registrationId: "reg2", eventId: "ev1", festId: "fest1", userId: student.uid, ticketCode: "FF-AAAAAAAAAA", scannedAt: new Date(), scannedBy: volunteer.uid, method: "qr", createdAt: new Date(), updatedAt: new Date() };
    await assertSucceeds(setDoc(doc(db, "attendance", "reg2"), record));
    await assertFails(setDoc(doc(db, "attendance", "reg2"), { ...record, scannedAt: new Date() })); // second scan is an update → denied
    await assertFails(setDoc(doc(as(otherVolunteer), "attendance", "reg3"), { ...record, id: "reg3", registrationId: "reg3", scannedBy: otherVolunteer.uid }));
  });
});

describe("notifications", () => {
  it("belong to their recipient: read, mark read, delete — nothing else", async () => {
    await assertSucceeds(getDocs(query(collection(as(student), "notifications"), where("userId", "==", student.uid))));
    await assertSucceeds(updateDoc(doc(as(student), "notifications", "n1"), { read: true, readAt: new Date(), updatedAt: new Date() }));
    await assertFails(updateDoc(doc(as(student), "notifications", "n1"), { title: "Edited", updatedAt: new Date() }));
    await assertFails(getDoc(doc(as(stranger), "notifications", "n1")));
    await assertFails(updateDoc(doc(as(stranger), "notifications", "n1"), { read: true, readAt: new Date(), updatedAt: new Date() }));
    await assertFails(setDoc(doc(as(admin), "notifications", "n2"), { userId: student.uid, type: "announcement", title: "x", body: "", read: false }));
  });
});

describe("certificates, email log, audit log", () => {
  it("a certificate is readable by its recipient and admin+ staff, never client-written", async () => {
    await assertSucceeds(getDoc(doc(as(student), "certificates", "ev1_stu1")));
    await assertFails(getDoc(doc(as(stranger), "certificates", "ev1_stu1")));
    await assertSucceeds(getDoc(doc(as(admin), "certificates", "ev1_stu1")));
    // A volunteer scans a gate; certificates are an admin+ concern.
    await assertFails(getDoc(doc(as(volunteer), "certificates", "ev1_stu1")));
    await assertFails(updateDoc(doc(as(student), "certificates", "ev1_stu1"), { type: "winner" }));
  });
  it("emailLog and auditLog are admin-scoped reads and server-only writes", async () => {
    await assertSucceeds(getDocs(query(collection(as(admin), "emailLog"), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(collection(as(student), "emailLog"), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(collection(as(volunteer), "emailLog"), where("festId", "==", "fest1"))));
    await assertFails(setDoc(doc(as(admin), "emailLog", "e2"), { to: "x", status: "sent" }));
    await assertSucceeds(getDocs(query(collection(as(admin), "auditLog"), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(collection(as(otherAdmin), "auditLog"), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(collection(as(volunteer), "auditLog"), where("festId", "==", "fest1"))));
    await assertFails(setDoc(doc(as(admin), "auditLog", "a2"), { action: "x" }));
  });
  it("an unknown collection is denied by default", async () => {
    await assertFails(getDoc(doc(as(admin), "secrets", "s1")));
    expect(true).toBe(true);
  });
});

describe("Live Event Engine — arenas, matches, matchLog", () => {
  it("arenas and matches are readable by anyone, signed in or not", async () => {
    await assertSucceeds(getDoc(doc(anon(), "arenas", "arena1")));
    await assertSucceeds(getDoc(doc(anon(), "matches", "match1")));
    await assertSucceeds(getDoc(doc(anon(), "matchLog", "log1")));
    await assertSucceeds(getDocs(query(collection(anon(), "matches"), where("status", "==", "live"))));
  });

  it("no client — student, volunteer or admin — can write an arena, a match or its timeline directly", async () => {
    await assertFails(setDoc(doc(as(admin), "arenas", "arena2"), { festId: "fest1", name: "Rogue", active: true }));
    await assertFails(updateDoc(doc(as(admin), "matches", "match1"), { status: "completed" }));
    await assertFails(updateDoc(doc(as(volunteer), "matches", "match1"), { "score.home": 5 }));
    await assertFails(setDoc(doc(as(volunteer), "matchLog", "log2"), { matchId: "match1", type: "goal", side: "home" }));
    // Every one of these must go through /api/volunteer/matches/[id]/action or
    // /api/admin/arenas — the arena-scoping and the audit trail live there,
    // not in a rule that cannot read a volunteer's Shift.
  });
});

describe("online payment", () => {
  const now = () => new Date();
  const paidEntry = (id: string, over: Record<string, unknown>) =>
    env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "registrations", id), {
        id, eventId: "ev1", festId: "fest1", userId: student.uid, type: "solo", status: "confirmed", seats: 1, ticketCode: `FF-${id.toUpperCase().padEnd(10, "A").slice(0, 10)}`,
        members: [{ name: "Stu One", email: student.email, userId: student.uid, isLeader: true, inviteStatus: "accepted" }], memberEmails: [student.email],
        eventTitle: "CTF", userName: "Stu One", userEmail: student.email, createdAt: now(), updatedAt: now(), ...over,
      });
    });

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "paymentAccounts", "fest1"), { festId: "fest1", provider: "test", mode: "sandbox", status: "active" });
      await setDoc(doc(db, "paymentSecrets", "fest1"), { festId: "fest1", blob: { v: 1, iv: "x", tag: "y", data: "z" } });
      await setDoc(doc(db, "payments", "reg1"), { registrationId: "reg1", festId: "fest1", userId: student.uid, amountPaise: 50000, status: "paid" });
      await setDoc(doc(db, "paymentEvents", "test_e1"), { provider: "test", eventId: "e1", state: "done" });
    });
  });

  it("no client — not the payer, not a fest admin, not anonymous — can read or write payment records or credentials", async () => {
    for (const [collectionName, id] of [["paymentAccounts", "fest1"], ["paymentSecrets", "fest1"], ["payments", "reg1"], ["paymentEvents", "test_e1"]] as const) {
      for (const identity of [anon(), as(student), as(stranger), as(volunteer), as(admin), as(otherAdmin)]) {
        await assertFails(getDoc(doc(identity, collectionName, id)));
        await assertFails(setDoc(doc(identity, collectionName, id), { status: "paid" }));
        await assertFails(updateDoc(doc(identity, collectionName, id), { status: "paid" }));
      }
      await assertFails(getDocs(collection(as(admin), collectionName)));
    }
  });

  it("an owner cannot cancel a paid entry from the client — that has to go through the API, which records the refund", async () => {
    await paidEntry("paid1", { paymentStatus: "paid" });
    await assertFails(updateDoc(doc(as(student), "registrations", "paid1"), { status: "cancelled", cancelledAt: now(), updatedAt: now() }));
    // Free and legacy entries (no paymentStatus, or not_required) are unchanged.
    await paidEntry("free1", {});
    await assertSucceeds(updateDoc(doc(as(student), "registrations", "free1"), { status: "cancelled", cancelledAt: now(), updatedAt: now() }));
    await paidEntry("free2", { paymentStatus: "not_required" });
    await assertSucceeds(updateDoc(doc(as(student), "registrations", "free2"), { status: "cancelled", cancelledAt: now(), updatedAt: now() }));
  });

  it("an owner cannot mark their own entry as paid or confirm an unpaid hold", async () => {
    await paidEntry("hold1", { status: "pending_payment", paymentStatus: "pending" });
    await assertFails(updateDoc(doc(as(student), "registrations", "hold1"), { status: "confirmed", paymentStatus: "paid", updatedAt: now() }));
    await assertFails(updateDoc(doc(as(student), "registrations", "hold1"), { paymentStatus: "paid", updatedAt: now() }));
    await assertFails(updateDoc(doc(as(student), "registrations", "hold1"), { status: "cancelled", cancelledAt: now(), updatedAt: now() }));
  });

  it("a scanner cannot record entry or a meal for an unpaid entry, but can for a paid or free one", async () => {
    const db = as(volunteer);
    const entry = (id: string) => ({ id, registrationId: id, eventId: "ev1", festId: "fest1", userId: student.uid, ticketCode: "FF-AAAAAAAAAA", scannedAt: now(), scannedBy: volunteer.uid, method: "qr", createdAt: now(), updatedAt: now() });
    const meal = (reg: string) => ({ id: `${reg}_lunch_1`, registrationId: reg, eventId: "ev1", festId: "fest1", userId: student.uid, ticketCode: "FF-AAAAAAAAAA", mealType: "lunch", servedOn: "2026-09-26", serving: 1, collectedAt: now(), collectedBy: volunteer.uid, createdAt: now(), updatedAt: now() });

    await paidEntry("unpaid1", { status: "pending_payment", paymentStatus: "pending" });
    await paidEntry("lapsed1", { status: "confirmed", paymentStatus: "refund_pending" });
    await paidEntry("review1", { status: "pending_payment", paymentStatus: "needs_review" });
    await paidEntry("paid2", { status: "confirmed", paymentStatus: "paid" });
    await paidEntry("free3", {});

    for (const id of ["unpaid1", "lapsed1", "review1"]) {
      await assertFails(setDoc(doc(db, "attendance", id), entry(id)));
      await assertFails(setDoc(doc(db, "foodCollections", `${id}_lunch_1`), meal(id)));
    }
    for (const id of ["paid2", "free3"]) {
      await assertSucceeds(setDoc(doc(db, "attendance", id), entry(id)));
      await assertSucceeds(setDoc(doc(db, "foodCollections", `${id}_lunch_1`), meal(id)));
    }
  });
});
