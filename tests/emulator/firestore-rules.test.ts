import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getCountFromServer, getDoc, getDocs, query, setDoc, updateDoc, where } from "firebase/firestore";
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
const superAdmin = { uid: "sup1", email: "sup1@plansphere.test", email_verified: true, role: "super_admin", festIds: [] as string[] };

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
  it("another student cannot read the profile", async () => {
    await assertFails(getDoc(doc(as(stranger), "users", student.uid)));
    await assertFails(getDoc(doc(anon(), "users", student.uid)));
  });
});

describe("users — staff reach is limited to their own fests", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const now = new Date();
      // A volunteer rostered on fest1 and one on fest2: staff profiles carry the fests they are assigned to.
      await setDoc(doc(db, "users", volunteer.uid), { id: volunteer.uid, email: volunteer.email, name: "Vol One", role: "volunteer", festIds: ["fest1"], disabled: false, createdAt: now, updatedAt: now });
      await setDoc(doc(db, "users", otherVolunteer.uid), { id: otherVolunteer.uid, email: otherVolunteer.email, name: "Vol Two", role: "volunteer", festIds: ["fest2"], disabled: false, createdAt: now, updatedAt: now });
    });
  });

  it("a volunteer or admin cannot read a participant's profile, whichever fest the participant is in", async () => {
    await assertFails(getDoc(doc(as(volunteer), "users", student.uid)));
    await assertFails(getDoc(doc(as(otherVolunteer), "users", student.uid)));
    await assertFails(getDoc(doc(as(admin), "users", student.uid)));
    await assertFails(getDoc(doc(as(otherAdmin), "users", student.uid)));
  });

  it("staff read the profile of an account assigned to one of their own fests, and no other", async () => {
    await assertSucceeds(getDoc(doc(as(admin), "users", volunteer.uid))); // admin of fest1 reads the fest1 volunteer (shift rostering)
    await assertSucceeds(getDoc(doc(as(volunteer), "users", volunteer.uid))); // themselves
    await assertFails(getDoc(doc(as(admin), "users", otherVolunteer.uid))); // fest2's volunteer is not theirs
    await assertFails(getDoc(doc(as(otherAdmin), "users", volunteer.uid)));
    await assertFails(getDoc(doc(as(otherVolunteer), "users", volunteer.uid)));
  });

  it("nobody but a super admin lists profiles, and a super admin reads any", async () => {
    await assertFails(getDocs(collection(as(admin), "users")));
    await assertFails(getDocs(query(collection(as(volunteer), "users"), where("festIds", "array-contains", "fest1"))));
    await assertFails(getDocs(collection(as(student), "users")));
    await assertFails(getDocs(collection(anon(), "users")));
    await assertSucceeds(getDocs(collection(as(superAdmin), "users")));
    await assertSucceeds(getDoc(doc(as(superAdmin), "users", student.uid)));
  });

  it("a staff account that has not changed its temporary password reads nothing", async () => {
    const temp = { ...admin, mustChangePassword: true };
    await assertFails(getDoc(doc(as(temp), "users", volunteer.uid)));
  });
});

describe("festPrivate (the Event Head's personal details)", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "festPrivate", "fest1"), { festId: "fest1", eventHead: { name: "H", designation: "D", phone: "+910000000000" }, createdAt: new Date() });
    });
  });
  it("no client can read or write it, not even the fest's own admin or a super admin", async () => {
    for (const who of [anon(), as(student), as(volunteer), as(admin), as(otherAdmin), as(superAdmin)]) {
      await assertFails(getDoc(doc(who, "festPrivate", "fest1")));
      await assertFails(getDocs(collection(who, "festPrivate")));
      await assertFails(setDoc(doc(who, "festPrivate", "fest1"), { festId: "fest1" }));
    }
  });
});

describe("fests and events (public catalogue)", () => {
  it("anyone reads published fests by slug, nobody reads drafts anonymously", async () => {
    await assertSucceeds(getDocs(query(collection(anon(), "fests"), where("slug", "==", "bits2bytes"), where("status", "==", "published"))));
    await assertFails(getDoc(doc(anon(), "fests", "draft")));
    // Staff of fest1 are strangers to a draft of another fest; only the platform reads it.
    await assertFails(getDoc(doc(as(admin), "fests", "draft")));
    await assertSucceeds(getDoc(doc(as(superAdmin), "fests", "draft")));
  });
  it("events are never written from a client, even by an admin", async () => {
    await assertFails(setDoc(doc(as(admin), "events", "ev9"), { title: "Rogue", festId: "fest1" }));
    await assertFails(updateDoc(doc(as(volunteer), "events", "ev1"), { capacity: 9999 }));
  });
});

describe("registrations", () => {
  it("only the person who made the entry reads it; a named teammate or a stranger cannot", async () => {
    await assertSucceeds(getDoc(doc(as(student), "registrations", "reg1")));
    // The entry carries every member's email, phone, college and ID: a teammate gets the redacted view from
    // GET /api/registrations/mine instead of the document.
    await assertFails(getDoc(doc(as(mate), "registrations", "reg1")));
    await assertFails(getDoc(doc(as(stranger), "registrations", "reg1")));
    await assertFails(getDoc(doc(anon(), "registrations", "reg1")));
  });
  it("list queries are provable only when scoped to the caller", async () => {
    await assertSucceeds(getDocs(query(collection(as(student), "registrations"), where("userId", "==", student.uid))));
    await assertFails(getDocs(query(collection(as(mate), "registrations"), where("memberEmails", "array-contains", mate.email))));
    await assertFails(getDocs(query(collection(as(stranger), "registrations"), where("memberEmails", "array-contains", mate.email))));
    await assertFails(getDocs(collection(as(student), "registrations")));
    await assertFails(getDocs(query(collection(as(student), "registrations"), where("userId", "==", mate.uid))));
  });
  it("admins read within their fest only; a volunteer reads none, the gate is served by the server", async () => {
    await assertSucceeds(getDoc(doc(as(admin), "registrations", "reg1")));
    await assertSucceeds(getDocs(query(collection(as(admin), "registrations"), where("festId", "==", "fest1"))));
    await assertFails(getDoc(doc(as(otherAdmin), "registrations", "reg1")));
    await assertFails(getDoc(doc(as(volunteer), "registrations", "reg1")));
    await assertFails(getDoc(doc(as(otherVolunteer), "registrations", "reg1")));
    await assertFails(getDocs(query(collection(as(volunteer), "registrations"), where("festId", "==", "fest1"))));
  });
  it("a staff LIST has to name a fest they manage: other fests, no fest, and by-event or by-ticket-code alone are refused", async () => {
    const reg = (who: ReturnType<typeof as>) => collection(who, "registrations");
    // Their own fest, by fest, by event within the fest, and by ticket code within the fest.
    await assertSucceeds(getDocs(query(reg(as(admin)), where("festId", "==", "fest1"), where("eventId", "==", "ev1"))));
    await assertSucceeds(getDocs(query(reg(as(admin)), where("festId", "==", "fest1"), where("ticketCode", "==", "FF-7K2M9QX4TB"))));
    await assertSucceeds(getDocs(query(reg(as(admin)), where("festId", "==", "fest1"))));
    // A volunteer is shown none of it, asked however it is asked.
    await assertFails(getDocs(query(reg(as(volunteer)), where("festId", "==", "fest1"), where("eventId", "==", "ev1"))));
    await assertFails(getDocs(query(reg(as(volunteer)), where("festId", "==", "fest1"), where("ticketCode", "==", "FF-7K2M9QX4TB"))));
    // Someone else's fest, however it is asked for.
    await assertFails(getDocs(query(reg(as(otherVolunteer)), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(reg(as(otherAdmin)), where("festId", "==", "fest1"), where("eventId", "==", "ev1"))));
    // A query that does not name a managed fest cannot be proved to stay inside one.
    await assertFails(getDocs(reg(as(volunteer))));
    await assertFails(getDocs(query(reg(as(volunteer)), where("eventId", "==", "ev1"))));
    await assertFails(getDocs(query(reg(as(volunteer)), where("ticketCode", "==", "FF-7K2M9QX4TB"))));
    await assertFails(getDocs(query(reg(as(admin)), where("userId", "==", student.uid))));
    await assertFails(getDocs(query(reg(as(volunteer)), where("memberEmails", "array-contains", student.email))));
    // The platform owner is unscoped.
    await assertSucceeds(getDocs(reg(as(superAdmin))));
    await assertSucceeds(getDocs(query(reg(as(superAdmin)), where("ticketCode", "==", "FF-7K2M9QX4TB"))));
  });
  it("a staff account on a temporary password reads no registration", async () => {
    const temp = { ...admin, mustChangePassword: true };
    await assertFails(getDoc(doc(as(temp), "registrations", "reg1")));
    await assertFails(getDocs(query(collection(as(temp), "registrations"), where("festId", "==", "fest1"))));
  });
  it("clients never create registrations, and the owner may only cancel", async () => {
    await assertFails(setDoc(doc(as(student), "registrations", "forged"), { userId: student.uid, eventId: "ev1", festId: "fest1", status: "confirmed" }));
    await assertFails(updateDoc(doc(as(student), "registrations", "reg1"), { seats: 50, updatedAt: new Date() }));
    await assertFails(updateDoc(doc(as(mate), "registrations", "reg1"), { status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() }));
    await assertSucceeds(updateDoc(doc(as(student), "registrations", "reg1"), { status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() }));
  });
});

describe("attendance, meals and shifts — a staff LIST is limited to events and fests they manage", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const now = new Date();
      await setDoc(doc(db, "events", "ev2"), { id: "ev2", festId: "fest2", slug: "other", title: "Other", status: "published", eventType: "solo", capacity: 10, registeredCount: 1, createdAt: now, updatedAt: now });
      await setDoc(doc(db, "attendance", "reg9"), { id: "reg9", registrationId: "reg9", eventId: "ev2", festId: "fest2", userId: "stu9", userName: "Other Person", userEmail: "other@plansphere.test", ticketCode: "FF-ZZZZZZZZZZ", scannedAt: now, scannedBy: otherVolunteer.uid, method: "qr", createdAt: now, updatedAt: now });
      await setDoc(doc(db, "foodCollections", "reg1_2026-09-26_lunch_1"), { id: "reg1_2026-09-26_lunch_1", registrationId: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid, mealType: "lunch", servedOn: "2026-09-26", collectedBy: volunteer.uid, createdAt: now });
      await setDoc(doc(db, "foodCollections", "reg9_2026-09-26_lunch_1"), { id: "reg9_2026-09-26_lunch_1", registrationId: "reg9", eventId: "ev2", festId: "fest2", userId: "stu9", mealType: "lunch", servedOn: "2026-09-26", collectedBy: otherVolunteer.uid, createdAt: now });
      await setDoc(doc(db, "shifts", "sh1"), { id: "sh1", festId: "fest1", userId: volunteer.uid, userName: "Vol", userEmail: volunteer.email, duty: "gate", date: "2026-09-26", startTime: "09:00", endTime: "12:00", createdBy: admin.uid, createdAt: now, updatedAt: now });
      await setDoc(doc(db, "shifts", "sh2"), { id: "sh2", festId: "fest2", userId: otherVolunteer.uid, userName: "Other Vol", userEmail: otherVolunteer.email, duty: "gate", date: "2026-09-26", startTime: "09:00", endTime: "12:00", createdBy: otherAdmin.uid, createdAt: now, updatedAt: now });
    });
  });

  it("attendance: their own event lists; another fest's event, or no event at all, is refused", async () => {
    const att = (who: ReturnType<typeof as>) => collection(who, "attendance");
    await assertSucceeds(getDocs(query(att(as(admin)), where("eventId", "==", "ev1"))));
    // A volunteer lists no check-ins: the gate's view of who is ticked off comes from the server.
    await assertFails(getDocs(query(att(as(volunteer)), where("eventId", "==", "ev1"))));
    await assertFails(getDocs(query(att(as(volunteer)), where("eventId", "==", "ev2"))));
    await assertFails(getDocs(query(att(as(otherAdmin)), where("eventId", "==", "ev1"))));
    await assertFails(getDocs(att(as(volunteer))));
    await assertFails(getDocs(query(att(as(volunteer)), where("userId", "==", "stu9"))));
    // The gate feed asks by fest rather than by event.
    await assertSucceeds(getDocs(query(att(as(admin)), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(att(as(volunteer)), where("festId", "==", "fest1"))));
    await assertSucceeds(getCountFromServer(query(att(as(admin)), where("festId", "==", "fest1"))));
    await assertSucceeds(getCountFromServer(query(att(as(admin)), where("eventId", "==", "ev1"))));
    await assertFails(getDocs(query(att(as(volunteer)), where("festId", "==", "fest2"))));
    await assertFails(getCountFromServer(query(att(as(otherAdmin)), where("festId", "==", "fest1"))));
    await assertFails(getCountFromServer(query(att(as(otherAdmin)), where("eventId", "==", "ev1"))));
    await assertSucceeds(getDocs(query(att(as(superAdmin)), where("eventId", "==", "ev2"))));
    // A student still lists their own check-ins.
    await assertSucceeds(getDocs(query(att(as(student)), where("userId", "==", student.uid))));
  });

  it("meals: same", async () => {
    const meals = (who: ReturnType<typeof as>) => collection(who, "foodCollections");
    await assertSucceeds(getDocs(query(meals(as(admin)), where("eventId", "==", "ev1"))));
    await assertFails(getDocs(query(meals(as(volunteer)), where("eventId", "==", "ev1"))));
    await assertFails(getDocs(query(meals(as(admin)), where("eventId", "==", "ev2"))));
    await assertFails(getDocs(meals(as(admin))));
    await assertSucceeds(getDocs(query(meals(as(admin)), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(meals(as(volunteer)), where("festId", "==", "fest1"))));
    await assertSucceeds(getCountFromServer(query(meals(as(admin)), where("festId", "==", "fest1"))));
    await assertFails(getCountFromServer(query(meals(as(otherAdmin)), where("festId", "==", "fest1"))));
    await assertSucceeds(getDocs(query(meals(as(admin)), where("eventId", "==", "ev1"), where("servedOn", "==", "2026-09-26"))));
    await assertSucceeds(getDocs(query(meals(as(student)), where("userId", "==", student.uid))));
    await assertFails(getDocs(query(meals(as(student)), where("userId", "==", "stu9"))));
  });

  it("certificates: an admin lists their own fest's, by fest or by event, and never another fest's", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const now = new Date();
      await setDoc(doc(ctx.firestore(), "certificates", "ev2_stu9"), { id: "ev2_stu9", userId: "stu9", eventId: "ev2", festId: "fest2", registrationId: "reg9", certificateNumber: "FF-2026-ZZZZZZZZ", type: "participation", recipientName: "Other Person", recipientEmail: "other@plansphere.test", eventTitle: "Other", festName: "Other Fest", revoked: false, delivery: { status: "sent", attempts: 1 }, issuedAt: now, issuedBy: otherAdmin.uid, createdAt: now, updatedAt: now });
    });
    const certs = (who: ReturnType<typeof as>) => collection(who, "certificates");
    await assertSucceeds(getDocs(query(certs(as(admin)), where("festId", "==", "fest1"))));
    await assertSucceeds(getDocs(query(certs(as(admin)), where("eventId", "==", "ev1"))));
    await assertSucceeds(getCountFromServer(query(certs(as(admin)), where("eventId", "==", "ev1"), where("revoked", "==", false))));
    await assertFails(getDocs(query(certs(as(admin)), where("festId", "==", "fest2"))));
    await assertFails(getDocs(query(certs(as(admin)), where("eventId", "==", "ev2"))));
    await assertFails(getDocs(certs(as(admin))));
    await assertFails(getDocs(query(certs(as(volunteer)), where("festId", "==", "fest1"))));
    await assertSucceeds(getDocs(query(certs(as(superAdmin)), where("festId", "==", "fest2"))));
    await assertSucceeds(getDocs(query(certs(as(student)), where("userId", "==", student.uid), where("revoked", "==", false))));
  });

  it("results: unpublished results are visible only to staff of that fest; published ones to everyone", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const now = new Date();
      const base = { festId: "fest1", entries: [], createdAt: now, updatedAt: now };
      await setDoc(doc(ctx.firestore(), "results", "ev1"), { id: "ev1", eventId: "ev1", status: "draft", ...base });
      await setDoc(doc(ctx.firestore(), "results", "ev2"), { id: "ev2", eventId: "ev2", status: "published", ...base, festId: "fest2" });
    });
    // A volunteer has no business with unpublished results.
    await assertFails(getDoc(doc(as(volunteer), "results", "ev1")));
    await assertSucceeds(getDoc(doc(as(admin), "results", "ev1")));
    await assertFails(getDoc(doc(as(otherAdmin), "results", "ev1")));
    await assertFails(getDoc(doc(as(student), "results", "ev1")));
    await assertFails(getDoc(doc(anon(), "results", "ev1")));
    await assertSucceeds(getDoc(doc(anon(), "results", "ev2")));
    // Opening the results screen for an event with nothing saved yet is a get on a document that does not exist.
    await assertSucceeds(getDoc(doc(as(admin), "results", "ev-nothing-yet")));
    await assertFails(getDoc(doc(as(student), "results", "ev-nothing-yet")));
    await assertSucceeds(getDocs(query(collection(as(admin), "results"), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(collection(as(admin), "results"), where("festId", "==", "fest2"), where("status", "==", "draft"))));
  });

  it("shifts: a fest's roster lists for that fest's staff only", async () => {
    const sh = (who: ReturnType<typeof as>) => collection(who, "shifts");
    await assertSucceeds(getDocs(query(sh(as(admin)), where("festId", "==", "fest1"))));
    await assertSucceeds(getDocs(query(sh(as(volunteer)), where("festId", "==", "fest1"), where("userId", "==", volunteer.uid))));
    await assertFails(getDocs(query(sh(as(admin)), where("festId", "==", "fest2"))));
    await assertFails(getDocs(query(sh(as(volunteer)), where("festId", "==", "fest2"), where("userId", "==", otherVolunteer.uid))));
    await assertFails(getDocs(sh(as(admin))));
    await assertFails(getDocs(query(sh(as(student)), where("festId", "==", "fest1"))));
  });
});

describe("attendance", () => {
  it("is readable by the holder, a teammate, and the fest's admins - not by a volunteer; never written by clients", async () => {
    await assertSucceeds(getDoc(doc(as(student), "attendance", "reg1")));
    await assertSucceeds(getDoc(doc(as(mate), "attendance", "reg1")));
    await assertSucceeds(getDoc(doc(as(admin), "attendance", "reg1")));
    await assertFails(getDoc(doc(as(volunteer), "attendance", "reg1")));
    await assertFails(getDoc(doc(as(stranger), "attendance", "reg1")));
    await assertFails(setDoc(doc(as(volunteer), "attendance", "reg2"), { registrationId: "reg2", eventId: "ev1", festId: "fest1", userId: "x" }));
  });
  it("an admin may ask whether a record exists yet; a volunteer and a student may not", async () => {
    await assertSucceeds(getDoc(doc(as(admin), "attendance", "reg-new")));
    await assertSucceeds(getDoc(doc(as(admin), "foodCollections", "reg-new_2026-09-26_lunch_1")));
    await assertFails(getDoc(doc(as(volunteer), "attendance", "reg-new")));
    await assertFails(getDoc(doc(as(volunteer), "foodCollections", "reg-new_2026-09-26_lunch_1")));
    await assertFails(getDoc(doc(as(student), "attendance", "reg-new")));
    await assertFails(getDoc(doc(as(otherAdmin), "attendance", "reg1")));
  });
  it("no client records a scan - the server does, after checking the duty and the competition", async () => {
    const db = as(volunteer);
    // A scan is only ever recorded for a registration that exists (the admission rule reads it).
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "registrations", "reg2"), { id: "reg2", eventId: "ev1", festId: "fest1", userId: student.uid, type: "solo", status: "confirmed", seats: 1, ticketCode: "FF-AAAAAAAAAA", members: [], memberEmails: [], eventTitle: "CTF", userName: "S", userEmail: student.email, createdAt: new Date(), updatedAt: new Date() });
    });
    const record = { id: "reg2", registrationId: "reg2", eventId: "ev1", festId: "fest1", userId: student.uid, ticketCode: "FF-AAAAAAAAAA", scannedAt: new Date(), scannedBy: volunteer.uid, method: "qr", createdAt: new Date(), updatedAt: new Date() };
    // Not the volunteer of the fest, not another fest's volunteer, not an admin, not the platform.
    await assertFails(setDoc(doc(db, "attendance", "reg2"), record));
    await assertFails(setDoc(doc(as(otherVolunteer), "attendance", "reg3"), { ...record, id: "reg3", registrationId: "reg3", scannedBy: otherVolunteer.uid }));
    await assertFails(setDoc(doc(as(admin), "attendance", "reg2"), record));
    await assertFails(setDoc(doc(as(superAdmin), "attendance", "reg2"), record));
    await assertFails(setDoc(doc(db, "foodCollections", "reg2_2026-09-26_lunch_1"), { id: "reg2_2026-09-26_lunch_1", registrationId: "reg2", eventId: "ev1", festId: "fest1", userId: student.uid, mealType: "lunch", servedOn: "2026-09-26", collectedBy: volunteer.uid }));
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

  it("a scanner writes neither entry nor meal from the client, paid or not: the server applies the admission table", async () => {
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
      await assertFails(setDoc(doc(db, "attendance", id), entry(id)));
      await assertFails(setDoc(doc(db, "foodCollections", `${id}_lunch_1`), meal(id)));
    }
  });
});

/* ───────────── event-level memberships ───────────── */

describe("event-level memberships (festMembers)", () => {
  // `role` is the ceiling the claim writer raises the token to (so the app lets them into the admin area); `br` is what the
  // account itself is. The rules read `br`, so an event role is only ever as strong as its membership.
  const member = (uid: string, role: string, extra: Record<string, unknown> = {}) => ({ uid, email: `${uid}@plansphere.test`, email_verified: true, role, br: "student", festIds: [] as string[], fm: ["fest1"], ...extra });
  const head = member("head1", "admin");
  const eventAdmin = member("eadm1", "admin"); // assigned to ev1 only
  const otherEventAdmin = member("eadm2", "admin"); // assigned to ev3 only
  const coordinator = member("coord1", "admin");
  const gateVolunteer = member("gvol1", "volunteer");
  const revoked = member("rev1", "admin");
  const suspended = member("susp1", "admin");
  const elsewhere = { ...member("else1", "admin"), fm: ["fest2"] }; // head of a DIFFERENT main event

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const now = new Date();
      const row = (uid: string, role: string, eventIds: string[], status = "active", duties: string[] = []) => setDoc(doc(db, "festMembers", `fest1__${uid}`), { id: `fest1__${uid}`, festId: "fest1", userId: uid, role, eventIds, duties, status, createdBy: "head1", createdAt: now, updatedAt: now });
      await row("head1", "head", []);
      await row("eadm1", "admin", ["ev1"]);
      await row("eadm2", "admin", ["ev3"]);
      await row("coord1", "coordinator", ["ev1"]);
      await row("gvol1", "volunteer", ["ev1"], "active", ["entry"]);
      await row("rev1", "admin", ["ev1"], "revoked");
      await row("susp1", "admin", ["ev1"], "suspended");
      await setDoc(doc(db, "festMembers", "fest2__else1"), { id: "fest2__else1", festId: "fest2", userId: "else1", role: "head", eventIds: [], duties: [], status: "active", createdBy: "x", createdAt: now, updatedAt: now });
      await setDoc(doc(db, "fests", "fest2"), { id: "fest2", slug: "other", name: "Other Fest", status: "published", organizationName: "T", startDate: "2026-09-25", endDate: "2026-09-27", stats: { events: 0, registrations: 0, checkIns: 0 }, createdAt: now, updatedAt: now });
      await setDoc(doc(db, "registrations", "reg-elsewhere"), { id: "reg-elsewhere", eventId: "ev2", festId: "fest2", userId: "stu9", type: "solo", status: "confirmed", seats: 1, ticketCode: "FF-9999999999", members: [], memberEmails: [], eventTitle: "Other", userName: "Other", userEmail: "o@x.test", createdAt: now, updatedAt: now });
      await setDoc(doc(db, "events", "ev3"), { id: "ev3", festId: "fest1", slug: "robo", title: "Robotics", status: "published", eventType: "team", capacity: 10, registeredCount: 1, createdAt: now, updatedAt: now });
      await setDoc(doc(db, "registrations", "reg3"), { id: "reg3", eventId: "ev3", festId: "fest1", userId: student.uid, type: "solo", status: "confirmed", seats: 1, ticketCode: "FF-3333333333", members: [], memberEmails: [student.email], eventTitle: "Robotics", userName: "Stu One", userEmail: student.email, createdAt: now, updatedAt: now });
      await setDoc(doc(db, "attendance", "reg3"), { id: "reg3", registrationId: "reg3", eventId: "ev3", festId: "fest1", userId: student.uid, ticketCode: "FF-3333333333", scannedAt: now, scannedBy: "gvol1", method: "qr", createdAt: now, updatedAt: now });
      await setDoc(doc(db, "results", "ev3"), { id: "ev3", eventId: "ev3", festId: "fest1", status: "draft", entries: [], createdAt: now, updatedAt: now });
      await setDoc(doc(db, "results", "ev1"), { id: "ev1", eventId: "ev1", festId: "fest1", status: "draft", entries: [], createdAt: now, updatedAt: now });
    });
  });

  it("lets the head read everything on their own fest, as a legacy admin would", async () => {
    await assertSucceeds(getDoc(doc(as(head), "registrations", "reg1")));
    await assertSucceeds(getDoc(doc(as(head), "registrations", "reg3")));
    await assertSucceeds(getDocs(query(collection(as(head), "registrations"), where("festId", "==", "fest1"))));
    await assertSucceeds(getDocs(query(collection(as(head), "attendance"), where("festId", "==", "fest1"))));
    await assertSucceeds(updateDoc(doc(as(head), "fests", "fest1"), { name: "Renamed By Head", updatedAt: new Date() }));
    // Never the platform's powers: not another main event, and not the fields only the platform changes.
    await assertFails(getDoc(doc(as(head), "registrations", "reg-elsewhere")));
    await assertFails(updateDoc(doc(as(head), "fests", "fest1"), { ownerId: "head1", updatedAt: new Date() }));
  });

  it("limits an admin to the competition they are assigned: its registrations, check-ins and results, not another's", async () => {
    await assertSucceeds(getDoc(doc(as(eventAdmin), "registrations", "reg1")));
    await assertFails(getDoc(doc(as(eventAdmin), "registrations", "reg3")));
    await assertSucceeds(getDocs(query(collection(as(eventAdmin), "registrations"), where("festId", "==", "fest1"), where("eventId", "==", "ev1"))));
    await assertFails(getDocs(query(collection(as(eventAdmin), "registrations"), where("festId", "==", "fest1"), where("eventId", "==", "ev3"))));
    // The whole fest, or a query that does not name a competition, is not provable and is refused.
    await assertFails(getDocs(query(collection(as(eventAdmin), "registrations"), where("festId", "==", "fest1"))));
    await assertSucceeds(getDoc(doc(as(eventAdmin), "attendance", "reg1")));
    await assertFails(getDoc(doc(as(eventAdmin), "attendance", "reg3")));
    await assertSucceeds(getDocs(query(collection(as(eventAdmin), "attendance"), where("eventId", "==", "ev1"))));
    await assertFails(getDocs(query(collection(as(eventAdmin), "attendance"), where("eventId", "==", "ev3"))));
    await assertSucceeds(getDoc(doc(as(eventAdmin), "results", "ev1")));
    await assertFails(getDoc(doc(as(eventAdmin), "results", "ev3")));
    // And the mirror image: the admin of the other competition sees only theirs.
    await assertSucceeds(getDoc(doc(as(otherEventAdmin), "registrations", "reg3")));
    await assertFails(getDoc(doc(as(otherEventAdmin), "registrations", "reg1")));
  });

  it("gives an admin no fest-wide power: no fest edits, no staff rosters, no audit log", async () => {
    await assertFails(updateDoc(doc(as(eventAdmin), "fests", "fest1"), { name: "Hijacked", updatedAt: new Date() }));
    await assertFails(getDocs(query(collection(as(eventAdmin), "auditLog"), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(collection(as(eventAdmin), "shifts"), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(collection(as(eventAdmin), "emailLog"), where("festId", "==", "fest1"))));
  });

  it("lets a coordinator read their competition's entries and nothing outside it", async () => {
    await assertSucceeds(getDoc(doc(as(coordinator), "registrations", "reg1")));
    await assertFails(getDoc(doc(as(coordinator), "registrations", "reg3")));
    await assertSucceeds(getDoc(doc(as(coordinator), "attendance", "reg1")));
    await assertFails(getDoc(doc(as(coordinator), "attendance", "reg3")));
    await assertFails(updateDoc(doc(as(coordinator), "fests", "fest1"), { name: "Hijacked", updatedAt: new Date() }));
    // Certificates are an admin's, not a coordinator's.
    await assertFails(getDocs(query(collection(as(coordinator), "certificates"), where("eventId", "==", "ev1"))));
  });

  it("gives a volunteer with a duty no registration, check-in, meal record or result to read", async () => {
    await assertFails(getDoc(doc(as(gateVolunteer), "registrations", "reg1")));
    await assertFails(getDocs(query(collection(as(gateVolunteer), "registrations"), where("festId", "==", "fest1"), where("eventId", "==", "ev1"))));
    await assertFails(getDoc(doc(as(gateVolunteer), "attendance", "reg1")));
    await assertFails(getDocs(query(collection(as(gateVolunteer), "attendance"), where("eventId", "==", "ev1"))));
    await assertFails(getDocs(query(collection(as(gateVolunteer), "foodCollections"), where("eventId", "==", "ev1"))));
    await assertFails(getDoc(doc(as(gateVolunteer), "results", "ev1")));
    await assertFails(setDoc(doc(as(gateVolunteer), "attendance", "regX"), { id: "regX", registrationId: "regX", eventId: "ev1", festId: "fest1", userId: "x", scannedBy: "gvol1" }));
  });

  it("stops a revoked or suspended member at once, whatever their token still says", async () => {
    for (const who of [revoked, suspended]) {
      await assertFails(getDoc(doc(as(who), "registrations", "reg1")));
      await assertFails(getDocs(query(collection(as(who), "attendance"), where("eventId", "==", "ev1"))));
      await assertFails(getDoc(doc(as(who), "results", "ev1")));
    }
  });

  it("keeps a role on one main event from reaching another", async () => {
    // Head of fest2 holds a membership there and none on fest1.
    await assertFails(getDoc(doc(as(elsewhere), "registrations", "reg1")));
    await assertFails(getDocs(query(collection(as(elsewhere), "registrations"), where("festId", "==", "fest1"))));
    await assertFails(updateDoc(doc(as(elsewhere), "fests", "fest1"), { name: "Hijacked", updatedAt: new Date() }));
    // And a claim naming a fest that has no membership document is worth nothing (get() on a missing document denies).
    const forged = member("forger", "admin");
    await assertFails(getDoc(doc(as(forged), "registrations", "reg1")));
    await assertFails(updateDoc(doc(as(forged), "fests", "fest1"), { name: "Hijacked", updatedAt: new Date() }));
  });

  it("does not let a membership override an older, wider scope in the account's favour", async () => {
    // Governed by a coordinator membership on fest1, an account that was once a legacy admin there (br admin, festIds fest1)
    // gets nothing extra from the older scope.
    const stale = member("coord1", "admin", { br: "admin", festIds: ["fest1"] });
    await assertFails(getDoc(doc(as(stale), "registrations", "reg3")));
    await assertFails(updateDoc(doc(as(stale), "fests", "fest1"), { name: "Hijacked", updatedAt: new Date() }));
  });

  it("does not let an event role on one fest lend admin powers on another where the account is only a volunteer", async () => {
    // Head of fest1 by membership, and an ordinary volunteer of fest2 by the older scheme: the claim role is raised to admin
    // (so the app opens the admin area), but br says what the account itself is.
    const both = member("head1", "admin", { br: "volunteer", festIds: ["fest2"] });
    await assertSucceeds(updateDoc(doc(as(both), "fests", "fest1"), { name: "Head Of This One", updatedAt: new Date() }));
    await assertFails(updateDoc(doc(as(both), "fests", "fest2"), { name: "Not Theirs", updatedAt: new Date() }));
    await assertFails(getDoc(doc(as(both), "registrations", "reg-elsewhere")));
    await assertFails(getDocs(query(collection(as(both), "registrations"), where("festId", "==", "fest2"))));
    await assertFails(getDocs(query(collection(as(both), "attendance"), where("festId", "==", "fest2"))));
    // They are still a volunteer there, with a volunteer's reach: the public fest page, nothing private.
    await assertSucceeds(getDoc(doc(as(both), "fests", "fest2")));
  });

  it("lets a person read their own memberships, the head read the fest's, and nobody write one", async () => {
    await assertSucceeds(getDoc(doc(as(eventAdmin), "festMembers", "fest1__eadm1")));
    await assertFails(getDoc(doc(as(eventAdmin), "festMembers", "fest1__coord1")));
    await assertSucceeds(getDocs(query(collection(as(eventAdmin), "festMembers"), where("userId", "==", "eadm1"))));
    await assertSucceeds(getDocs(query(collection(as(head), "festMembers"), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(collection(as(eventAdmin), "festMembers"), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(collection(as(elsewhere), "festMembers"), where("festId", "==", "fest1"))));
    for (const who of [eventAdmin, head, superAdmin, gateVolunteer]) {
      await assertFails(setDoc(doc(as(who), "festMembers", "fest1__self"), { id: "fest1__self", festId: "fest1", userId: who.uid, role: "head", eventIds: [], duties: [], status: "active" }));
      await assertFails(updateDoc(doc(as(who), "festMembers", "fest1__eadm1"), { eventIds: ["ev1", "ev3"] }));
    }
  });
});

/* ───────────── draft fests and competitions are private to the people who run them ───────────── */

describe("drafts across fests", () => {
  const staff = (uid: string, role: string, festId: string) => ({ uid, email: `${uid}@plansphere.test`, email_verified: true, role, festIds: [festId] });
  const adminA = staff("dadm1", "admin", "draftA");
  const volunteerA = staff("dvol1", "volunteer", "draftA");
  const adminB = staff("dadm2", "admin", "draftB");
  const volunteerB = staff("dvol2", "volunteer", "draftB");

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const now = new Date();
      const fest = (id: string, verification?: Record<string, unknown>) =>
        setDoc(doc(db, "fests", id), { id, slug: id, name: id, status: "draft", organizationName: "T", startDate: "2026-10-01", endDate: "2026-10-02", stats: { events: 0, registrations: 0, checkIns: 0 }, createdAt: now, updatedAt: now, ...(verification ? { verification } : {}) });
      await fest("draftA");
      await fest("draftB", { status: "approved", submittedAt: now, basis: "review" });
      await fest("draftC", { status: "pending", submittedAt: now });
      const event = (id: string, festId: string) => setDoc(doc(db, "events", id), { id, festId, slug: id, title: id, status: "draft", eventType: "solo", capacity: 5, registeredCount: 0, createdAt: now, updatedAt: now });
      await event("evA", "draftA");
      await event("evB", "draftB");
      const row = (uid: string, role: string, eventIds: string[]) => setDoc(doc(db, "festMembers", `draftA__${uid}`), { id: `draftA__${uid}`, festId: "draftA", userId: uid, role, eventIds, duties: [], status: "active", createdBy: "x", createdAt: now, updatedAt: now });
      await row("headA", "head", []);
      await row("coordA", "coordinator", ["evA"]);
    });
  });

  it("lets only the people who run a draft fest read it - never the staff of another fest, whatever its own status", async () => {
    for (const who of [adminA, volunteerA]) await assertSucceeds(getDoc(doc(as(who), "fests", "draftA")));
    for (const who of [adminB, volunteerB]) await assertSucceeds(getDoc(doc(as(who), "fests", "draftB")));
    for (const who of [adminB, volunteerB]) {
      await assertFails(getDoc(doc(as(who), "fests", "draftA")));
      await assertFails(getDoc(doc(as(who), "fests", "draftC")));
    }
    for (const who of [adminA, volunteerA]) {
      await assertFails(getDoc(doc(as(who), "fests", "draftB")));
      await assertFails(getDoc(doc(as(who), "fests", "draftC")));
    }
    // Neither can a student or a signed-out visitor; the platform can.
    await assertFails(getDoc(doc(as(student), "fests", "draftA")));
    await assertFails(getDoc(doc(anon(), "fests", "draftA")));
    await assertSucceeds(getDoc(doc(as(superAdmin), "fests", "draftA")));
    await assertSucceeds(getDoc(doc(as(superAdmin), "fests", "draftC")));
  });

  it("lets everyone who holds an event role on the fest read it, and nobody who holds one only elsewhere", async () => {
    const member = (uid: string, festId = "draftA") => ({ uid, email: `${uid}@plansphere.test`, email_verified: true, role: "admin", br: "student", festIds: [] as string[], fm: [festId] });
    await assertSucceeds(getDoc(doc(as(member("headA")), "fests", "draftA")));
    await assertSucceeds(getDoc(doc(as(member("coordA")), "fests", "draftA")));
    await assertFails(getDoc(doc(as(member("headA", "draftB")), "fests", "draftB"))); // a token naming a fest it holds no membership on
    await assertFails(getDoc(doc(as(member("headA")), "fests", "draftB")));
  });

  it("applies the same rule to draft competitions: get and list", async () => {
    await assertSucceeds(getDoc(doc(as(adminA), "events", "evA")));
    await assertSucceeds(getDoc(doc(as(volunteerA), "events", "evA")));
    await assertFails(getDoc(doc(as(adminB), "events", "evA")));
    await assertFails(getDoc(doc(as(volunteerB), "events", "evA")));
    await assertFails(getDoc(doc(as(student), "events", "evA")));
    await assertFails(getDoc(doc(anon(), "events", "evA")));
    await assertSucceeds(getDoc(doc(as(superAdmin), "events", "evA")));

    const ofFest = (who: ReturnType<typeof as>, festId: string) => getDocs(query(collection(who, "events"), where("festId", "==", festId)));
    await assertSucceeds(ofFest(as(adminA), "draftA"));
    await assertSucceeds(ofFest(as(volunteerA), "draftA"));
    await assertFails(ofFest(as(adminB), "draftA"));
    await assertFails(ofFest(as(volunteerB), "draftA"));
    await assertSucceeds(ofFest(as(superAdmin), "draftA"));
    // A staff query that names no fest cannot be proved to stay inside one.
    await assertFails(getDocs(collection(as(adminA), "events")));
    await assertFails(getDocs(query(collection(as(adminA), "events"), where("status", "==", "draft"))));
  });

  it("lets a head or coordinator by membership read their fest's draft competitions, and not another fest's", async () => {
    const member = (uid: string) => ({ uid, email: `${uid}@plansphere.test`, email_verified: true, role: "admin", br: "student", festIds: [] as string[], fm: ["draftA"] });
    for (const uid of ["headA", "coordA"]) {
      await assertSucceeds(getDoc(doc(as(member(uid)), "events", "evA")));
      await assertSucceeds(getDocs(query(collection(as(member(uid)), "events"), where("festId", "==", "draftA"))));
      await assertFails(getDoc(doc(as(member(uid)), "events", "evB")));
      await assertFails(getDocs(query(collection(as(member(uid)), "events"), where("festId", "==", "draftB"))));
    }
  });

  it("leaves published fests and competitions public to everyone, as before", async () => {
    await assertSucceeds(getDoc(doc(anon(), "fests", "fest1")));
    await assertSucceeds(getDoc(doc(as(adminB), "fests", "fest1")));
    await assertSucceeds(getDoc(doc(anon(), "events", "ev1")));
    await assertSucceeds(getDocs(query(collection(anon(), "events"), where("status", "in", ["published", "ongoing", "completed"]))));
    await assertSucceeds(getDocs(query(collection(as(adminB), "events"), where("festId", "==", "fest1"), where("status", "in", ["published", "ongoing"]))));
  });
});

/* ───────────── many event roles: the token points, the membership decides ───────────── */

describe("lookup mode (an account with too many event roles to list in its token)", () => {
  const lookup = (uid: string, withFlag = true) => ({ uid, email: `${uid}@plansphere.test`, email_verified: true, role: "admin", br: "student", festIds: [] as string[], ...(withFlag ? { fx: true } : {}) });

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const now = new Date();
      const row = (festId: string, uid: string, role: string, eventIds: string[], status = "active") =>
        setDoc(doc(db, "festMembers", `${festId}__${uid}`), { id: `${festId}__${uid}`, festId, userId: uid, role, eventIds, duties: [], status, createdBy: "x", createdAt: now, updatedAt: now });
      await row("fest1", "many1", "head", []);
      await row("fest1", "many2", "admin", ["ev1"]);
      await row("fest1", "many3", "head", [], "revoked");
      await setDoc(doc(db, "fests", "fest2"), { id: "fest2", slug: "f2", name: "F2", status: "published", organizationName: "T", startDate: "2026-09-25", endDate: "2026-09-27", stats: { events: 0, registrations: 0, checkIns: 0 }, createdAt: now, updatedAt: now });
    });
  });

  it("grants exactly what the membership grants, with no list in the token", async () => {
    await assertSucceeds(updateDoc(doc(as(lookup("many1")), "fests", "fest1"), { name: "Renamed By Head", updatedAt: new Date() }));
    await assertSucceeds(getDoc(doc(as(lookup("many1")), "registrations", "reg1")));
    await assertSucceeds(getDoc(doc(as(lookup("many2")), "registrations", "reg1"))); // admin of ev1, which reg1 is in
    await assertFails(updateDoc(doc(as(lookup("many2")), "fests", "fest1"), { name: "Hijacked", updatedAt: new Date() })); // an admin is not the head
  });

  it("grants nothing on a fest where the account holds no membership, or a revoked one", async () => {
    await assertFails(updateDoc(doc(as(lookup("many1")), "fests", "fest2"), { name: "Hijacked", updatedAt: new Date() }));
    await assertFails(getDoc(doc(as(lookup("many3")), "registrations", "reg1")));
    await assertFails(updateDoc(doc(as(lookup("many3")), "fests", "fest1"), { name: "Hijacked", updatedAt: new Date() }));
    await assertFails(getDoc(doc(as(lookup("nobody")), "registrations", "reg1")));
  });

  it("is only a pointer: without the flag the membership is not consulted, and it only ever reads the caller's own", async () => {
    await assertFails(getDoc(doc(as(lookup("many1", false)), "registrations", "reg1")));
    await assertFails(getDoc(doc(as(lookup("intruder")), "registrations", "reg1")));
  });
});
