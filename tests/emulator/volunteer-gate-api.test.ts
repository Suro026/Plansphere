import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { memberKeyFor } from "@/core/models/attendance";
import { membershipIdFor, type Duty, type FestRole } from "@/core/models/membership";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { syncMemberAccess } from "@/server/membership";
import { GET as roster } from "@/app/api/volunteer/roster/route";
import { POST as scan } from "@/app/api/volunteer/scan/route";
import { POST as meal } from "@/app/api/volunteer/meal/route";
import { callRoute, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * The gate, through the real handlers against the Firestore and Auth emulators.
 *
 * A volunteer used to read whole registrations into their phone and write the check-in themselves. Now the phone is sent
 * a minimal roster for one competition and asks the server to record each entry and meal. These tests pin down what that
 * means: what is, and is not, in the roster; which duty and which competition each volunteer may act on; that taking a
 * role away stops it on the next request; and that the admission rule and the one-record-per-entry guarantees survived
 * the move off the client.
 */

const STUDENT_EMAIL = "holder.private@college.test";
const MATE_EMAIL = "mate.private@college.test";
const PHONE = "+919876501234";
const COLLEGE = "Very Private Institute";
const ANSWER = "my secret registration answer";

let student: TestUser;
let entryVolunteer: TestUser; // member: ev1, duty entry
let mealVolunteer: TestUser; // member: ev1, duty meal
let scoringVolunteer: TestUser; // member: ev1, duty scoring only
let ev2Volunteer: TestUser; // member: ev2 only
let legacyVolunteer: TestUser; // pre-membership volunteer of fest1
let otherFestVolunteer: TestUser;
let eventAdmin: TestUser; // member admin of ev1
let coordinator: TestUser; // member coordinator of ev1

const grant = async (user: TestUser, role: FestRole, eventIds: string[], duties: Duty[] = [], status = "active", festId = "fest1") => {
  await adminDb()
    .collection(COLLECTIONS.festMembers)
    .doc(membershipIdFor(festId, user.uid))
    .set({ id: membershipIdFor(festId, user.uid), festId, userId: user.uid, role, eventIds, duties, status, createdBy: "head", createdAt: new Date(), updatedAt: new Date() });
  await syncMemberAccess(user.uid);
};

const seedRegistration = async (id: string, over: Record<string, unknown> = {}) =>
  adminDb()
    .collection(COLLECTIONS.registrations)
    .doc(id)
    .set({
      id,
      eventId: "ev1",
      festId: "fest1",
      userId: student.uid,
      type: "team",
      teamName: "Null Pointers",
      members: [
        { name: "Holder Name", email: STUDENT_EMAIL, phone: PHONE, college: COLLEGE, userId: student.uid, isLeader: true, inviteStatus: "accepted" },
        { name: "Mate Name", email: MATE_EMAIL, phone: "+919876509999", college: COLLEGE, isLeader: false, inviteStatus: "accepted" },
      ],
      memberEmails: [STUDENT_EMAIL, MATE_EMAIL],
      answers: { diet: ANSWER },
      seats: 2,
      ticketCode: "PS-7K2M9QX4TB",
      status: "confirmed",
      eventTitle: "Capture the Flag",
      userName: "Holder Name",
      userEmail: STUDENT_EMAIL,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });

const seedUsers = async () => {
  const all: Array<[TestUser, string[]]> = [[student, []], [entryVolunteer, []], [mealVolunteer, []], [scoringVolunteer, []], [ev2Volunteer, []], [legacyVolunteer, ["fest1"]], [otherFestVolunteer, ["fest2"]], [eventAdmin, []], [coordinator, []]];
  for (const [u, festIds] of all) {
    await adminDb().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, name: u.name, role: u.role === "student" ? "student" : u.role === "admin" ? "student" : u.role, festIds, profileCompleted: true, mustChangePassword: false, createdAt: new Date(), updatedAt: new Date() });
  }
};

beforeAll(async () => {
  await resetAuth();
  student = await mintUser({ name: "Holder Name", email: STUDENT_EMAIL });
  entryVolunteer = await mintUser({ name: "Entry Volunteer" });
  mealVolunteer = await mintUser({ name: "Meal Volunteer" });
  scoringVolunteer = await mintUser({ name: "Scoring Volunteer" });
  ev2Volunteer = await mintUser({ name: "Event Two Volunteer" });
  legacyVolunteer = await mintUser({ role: "volunteer", festIds: ["fest1"], name: "Legacy Volunteer" });
  otherFestVolunteer = await mintUser({ role: "volunteer", festIds: ["fest2"], name: "Other Fest Volunteer" });
  eventAdmin = await mintUser({ name: "Event Admin" });
  coordinator = await mintUser({ name: "Event Coordinator" });
});

beforeEach(async () => {
  await resetFirestore();
  await seedFest();
  await seedFest({ id: "fest2", slug: "other", name: "Other Fest" });
  await seedEvent({ mealSlots: [{ type: "lunch", time: "13:00" }] });
  await seedEvent({ id: "ev2", slug: "robo", title: "Robotics" });
  await seedUsers();
  await grant(entryVolunteer, "volunteer", ["ev1"], ["entry"]);
  await grant(mealVolunteer, "volunteer", ["ev1"], ["meal"]);
  await grant(scoringVolunteer, "volunteer", ["ev1"], ["scoring"]);
  await grant(ev2Volunteer, "volunteer", ["ev2"], ["entry", "meal"]);
  await grant(eventAdmin, "admin", ["ev1"]);
  await grant(coordinator, "coordinator", ["ev1"]);
  await seedRegistration("reg1");
});

const getRoster = (user: TestUser | null, eventId = "ev1") =>
  callRoute(roster, { path: `/api/volunteer/roster?eventId=${eventId}`, ...(user ? { token: user.idToken } : {}) });
const doScan = (user: TestUser | null, body: Record<string, unknown> = {}) =>
  callRoute(scan, { path: "/api/volunteer/scan", ...(user ? { token: user.idToken } : {}), body: { eventId: "ev1", ticketCode: "PS-7K2M9QX4TB", ...body } });
const doMeal = (user: TestUser | null, body: Record<string, unknown> = {}) =>
  callRoute(meal, { path: "/api/volunteer/meal", ...(user ? { token: user.idToken } : {}), body: { eventId: "ev1", ticketCode: "PS-7K2M9QX4TB", mealType: "lunch", servedOn: "2026-09-26", ...body } });

/* ───────────── what a volunteer is sent ───────────── */

describe("the gate roster is the minimum the gate needs", () => {
  it("carries names, ticket codes, who is on the entry and its admission state - and no contact detail, answer or id", async () => {
    for (const who of [entryVolunteer, legacyVolunteer]) {
      const res = await getRoster(who);
      expect(res.status, who.name).toBe(200);
      expect(res.body.roster).toHaveLength(1);
      expect(res.body.roster[0]).toMatchObject({ ticketCode: "PS-7K2M9QX4TB", registrationId: "reg1", teamName: "Null Pointers", memberCount: 2, status: "confirmed" });
      expect(res.body.roster[0].members.map((m: { name: string }) => m.name).sort()).toEqual(["Holder Name", "Mate Name"]);

      // Nothing private anywhere in the answer - searched as text, so a field added later is caught too.
      const text = JSON.stringify(res.body);
      for (const secret of [STUDENT_EMAIL, MATE_EMAIL, PHONE, "+919876509999", COLLEGE, ANSWER, student.uid]) expect(text, `${who.name} sees ${secret}`).not.toContain(secret);
      expect(res.body.roster[0]).not.toHaveProperty("userEmail");
      expect(res.body.roster[0]).not.toHaveProperty("userId");
      expect(res.body.roster[0]).not.toHaveProperty("answers");
      // The key the device ticks people off by is still there, derived server-side from the real address.
      expect(res.body.roster[0].members.map((m: { key: string }) => m.key).sort()).toEqual([memberKeyFor(STUDENT_EMAIL), memberKeyFor(MATE_EMAIL)].sort());
      // A masked address tells two people with the same name apart, and reveals nothing usable.
      for (const member of res.body.roster[0].members) expect(member.email).toMatch(/^.{1,2}_+@/);
    }
  });

  it("includes who is already ticked off, and who has had their meal, for the duties the volunteer holds", async () => {
    expect((await doScan(entryVolunteer, { memberKeys: [memberKeyFor(STUDENT_EMAIL)] })).body.result).toBe("ok");
    expect((await doMeal(mealVolunteer)).body.result).toBe("ok");

    const entry = await getRoster(entryVolunteer);
    expect(entry.body.checkins).toHaveLength(1);
    expect(entry.body.checkins[0].members).toEqual([memberKeyFor(STUDENT_EMAIL)]);
    // The entry volunteer is not on the meal counter, so they are not told who has eaten.
    expect(entry.body.meals).toEqual([]);

    const food = await getRoster(mealVolunteer);
    expect(food.body.meals).toHaveLength(1);
    expect(food.body.meals[0].members.sort()).toEqual([memberKeyFor(STUDENT_EMAIL), memberKeyFor(MATE_EMAIL)].sort());
    expect(food.body.checkins).toEqual([]);
  });
});

/* ───────────── duties ───────────── */

describe("a volunteer works only the duties they were given", () => {
  it("lets the entry volunteer scan entries and not hand out meals", async () => {
    expect((await doScan(entryVolunteer)).status).toBe(200);
    expect((await doMeal(entryVolunteer)).status).toBe(403);
    expect((await adminDb().collection(COLLECTIONS.foodCollections).get()).size).toBe(0);
  });

  it("lets the meal volunteer hand out meals and not scan entries", async () => {
    expect((await doMeal(mealVolunteer)).status).toBe(200);
    expect((await doScan(mealVolunteer)).status).toBe(403);
    expect((await adminDb().collection(COLLECTIONS.attendance).get()).size).toBe(0);
  });

  it("gives a scoring-only volunteer neither the roster nor either scan", async () => {
    expect((await getRoster(scoringVolunteer)).status).toBe(403);
    expect((await doScan(scoringVolunteer)).status).toBe(403);
    expect((await doMeal(scoringVolunteer)).status).toBe(403);
  });
});

/* ───────────── competitions ───────────── */

describe("a volunteer works only the competitions they were assigned, on one main event and no other", () => {
  beforeEach(async () => {
    await seedRegistration("reg2", { eventId: "ev2", ticketCode: "PS-2222222222", eventTitle: "Robotics" });
  });

  it("refuses the roster, scan and meal of a competition they are not assigned to", async () => {
    expect((await getRoster(entryVolunteer, "ev2")).status).toBe(403);
    expect((await doScan(entryVolunteer, { eventId: "ev2", ticketCode: "PS-2222222222" })).status).toBe(403);
    expect((await doMeal(mealVolunteer, { eventId: "ev2", ticketCode: "PS-2222222222" })).status).toBe(403);
    expect((await getRoster(ev2Volunteer, "ev1")).status).toBe(403);
    expect((await doScan(ev2Volunteer)).status).toBe(403);
    // Their own competition is fine.
    expect((await getRoster(ev2Volunteer, "ev2")).status).toBe(200);
    expect((await doScan(ev2Volunteer, { eventId: "ev2", ticketCode: "PS-2222222222" })).body.result).toBe("ok");
    expect((await adminDb().collection(COLLECTIONS.attendance).doc("reg1").get()).exists).toBe(false);
  });

  it("does not let a ticket for one competition be used at another: it is turned away as the wrong event", async () => {
    const res = await doScan(entryVolunteer, { ticketCode: "PS-2222222222" });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("wrong-event");
    expect((await adminDb().collection(COLLECTIONS.attendance).get()).size).toBe(0);
  });

  it("refuses a volunteer of another main event outright, and an unknown competition", async () => {
    expect((await getRoster(otherFestVolunteer)).status).toBe(403);
    expect((await doScan(otherFestVolunteer)).status).toBe(403);
    expect((await doMeal(otherFestVolunteer)).status).toBe(403);
    expect((await getRoster(entryVolunteer, "no-such-event")).status).toBe(404);
  });

  it("refuses a student and an anonymous caller", async () => {
    expect((await getRoster(student)).status).toBe(403);
    expect((await doScan(student)).status).toBe(403);
    expect((await getRoster(null)).status).toBe(401);
    expect((await doScan(null)).status).toBe(401);
    expect((await doMeal(null)).status).toBe(401);
  });

  it("keeps working for a volunteer who predates memberships, across the whole fest as before", async () => {
    expect((await getRoster(legacyVolunteer)).status).toBe(200);
    expect((await doScan(legacyVolunteer)).body.result).toBe("ok");
    expect((await getRoster(legacyVolunteer, "ev2")).status).toBe(200);
  });

  it("lets an admin or coordinator of a competition work its gate, and no other's", async () => {
    for (const who of [eventAdmin, coordinator]) {
      expect((await getRoster(who)).status, who.name).toBe(200);
      expect((await getRoster(who, "ev2")).status, who.name).toBe(403);
      expect((await doScan(who, { eventId: "ev2", ticketCode: "PS-2222222222" })).status, who.name).toBe(403);
    }
  });
});

/* ───────────── taking a role away ───────────── */

describe("revoking or suspending a role stops it on the very next request", () => {
  it("refuses a revoked volunteer with the same token they used a moment ago", async () => {
    expect((await getRoster(entryVolunteer)).status).toBe(200);
    await adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor("fest1", entryVolunteer.uid)).update({ status: "revoked" });
    expect((await getRoster(entryVolunteer)).status).toBe(403);
    expect((await doScan(entryVolunteer)).status).toBe(403);
  });

  it("refuses a suspended volunteer, and lets them back in when reinstated", async () => {
    const ref = adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor("fest1", entryVolunteer.uid));
    await ref.update({ status: "suspended" });
    expect((await doScan(entryVolunteer)).status).toBe(403);
    await ref.update({ status: "active" });
    expect((await doScan(entryVolunteer)).status).toBe(200);
  });

  it("takes effect for a volunteer who loses the duty or the competition without a new sign-in", async () => {
    const ref = adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor("fest1", entryVolunteer.uid));
    await ref.update({ duties: ["meal"] });
    expect((await doScan(entryVolunteer)).status).toBe(403);
    await ref.update({ duties: ["entry"], eventIds: ["ev2"] });
    expect((await doScan(entryVolunteer)).status).toBe(403);
  });
});

/* ───────────── the scan itself ───────────── */

describe("scanning keeps its guarantees now that it is on the server", () => {
  it("checks an entry in once, bumps the fest counter once, and reports the duplicate with who did it", async () => {
    const first = await doScan(entryVolunteer, { gate: "Gate A" });
    expect(first.body).toMatchObject({ result: "ok", registration: { id: "reg1", teamName: "Null Pointers", memberCount: 2 } });
    expect(first.body.members).toHaveLength(2);
    for (const member of first.body.members) expect(member.email).not.toContain("private@college.test");

    const second = await doScan(entryVolunteer);
    expect(second.body.result).toBe("already-recorded");
    expect(second.body.by).toBe("Entry Volunteer");

    expect((await adminDb().collection(COLLECTIONS.attendance).get()).size).toBe(1);
    expect((await adminDb().collection(COLLECTIONS.fests).doc("fest1").get()).data()?.stats.checkIns).toBe(1);
    const record = (await adminDb().collection(COLLECTIONS.attendance).doc("reg1").get()).data()!;
    expect(record).toMatchObject({ scannedBy: entryVolunteer.uid, method: "qr", gate: "Gate A" });
  });

  it("lets a team arrive in waves: the second scan adds only the people who have now turned up", async () => {
    const holder = memberKeyFor(STUDENT_EMAIL);
    const mate = memberKeyFor(MATE_EMAIL);
    const one = await doScan(entryVolunteer, { memberKeys: [holder] });
    expect(one.body.marked).toEqual([holder]);
    const again = await doScan(entryVolunteer, { memberKeys: [holder] });
    expect(again.body.result).toBe("already-recorded");
    const two = await doScan(entryVolunteer, { memberKeys: [mate] });
    expect(two.body.marked).toEqual([mate]);
    expect(two.body.members.filter((m: { done: boolean }) => m.done)).toHaveLength(2);

    const record = (await adminDb().collection(COLLECTIONS.attendance).doc("reg1").get()).data()!;
    expect(record.members.map((m: { key: string }) => m.key).sort()).toEqual([holder, mate].sort());
    // The fest counter counts entries through the gate, not heads.
    expect((await adminDb().collection(COLLECTIONS.fests).doc("fest1").get()).data()?.stats.checkIns).toBe(1);
  });

  it("records a scan made offline at the time it was made, and distrusts an implausible time", async () => {
    const earlier = Date.now() - 20 * 60 * 1000;
    await doScan(entryVolunteer, { scannedAt: earlier, memberKeys: [memberKeyFor(STUDENT_EMAIL)] });
    const record = (await adminDb().collection(COLLECTIONS.attendance).doc("reg1").get()).data()!;
    expect(record.queuedOffline).toBe(true);
    expect(record.members[0].at.toDate().getTime()).toBe(earlier);

    await adminDb().collection(COLLECTIONS.attendance).doc("reg1").delete();
    const future = Date.now() + 3 * 24 * 60 * 60 * 1000;
    await doScan(entryVolunteer, { scannedAt: future, memberKeys: [memberKeyFor(STUDENT_EMAIL)] });
    const clamped = (await adminDb().collection(COLLECTIONS.attendance).doc("reg1").get()).data()!;
    expect(clamped.members[0].at.toDate().getTime()).toBeLessThan(Date.now() + 60_000);
  });

  it("refuses unknown codes and cancelled entries without recording anything", async () => {
    await seedRegistration("reg-x", { status: "cancelled", ticketCode: "PS-CANCELLED1" });
    expect((await doScan(entryVolunteer, { ticketCode: "PS-NOTINROSTR" })).body).toEqual({ result: "not-found" });
    expect((await doScan(entryVolunteer, { ticketCode: "PS-CANCELLED1" })).body.result).toBe("cancelled");
    expect((await adminDb().collection(COLLECTIONS.attendance).get()).size).toBe(0);
  });

  it("will not take a ticket from another main event, even by its code", async () => {
    await seedRegistration("reg-other", { festId: "fest2", eventId: "ev-other", ticketCode: "PS-OTHERFEST1" });
    expect((await doScan(entryVolunteer, { ticketCode: "PS-OTHERFEST1" })).body).toEqual({ result: "not-found" });
  });

  it("hands out one meal per member per round, and refuses a second helping", async () => {
    const holder = memberKeyFor(STUDENT_EMAIL);
    const first = await doMeal(mealVolunteer, { memberKeys: [holder] });
    expect(first.body).toMatchObject({ result: "ok", serving: { n: 1, of: 2 }, marked: [holder] });
    expect((await doMeal(mealVolunteer, { memberKeys: [holder] })).body.result).toBe("already-recorded");
    const second = await doMeal(mealVolunteer, { memberKeys: [memberKeyFor(MATE_EMAIL)] });
    // `serving.n` counts the servings made by this scan (the first member of this entry to eat was served by the scan before).
    expect(second.body).toMatchObject({ result: "ok", serving: { n: 1, of: 2 }, marked: [memberKeyFor(MATE_EMAIL)] });
    expect((await doMeal(mealVolunteer)).body.result).toBe("already-recorded");
    expect((await adminDb().collection(COLLECTIONS.foodCollections).get()).size).toBe(2);
  });

  it("serves two counters at once without a second helping", async () => {
    const results = await Promise.all([doMeal(mealVolunteer), doMeal(mealVolunteer), doMeal(mealVolunteer)]);
    expect(results.filter((r) => r.body.result === "ok")).toHaveLength(1);
    expect((await adminDb().collection(COLLECTIONS.foodCollections).get()).size).toBe(2);
  });

  it("checks in once even when two volunteers scan the same ticket in the same moment", async () => {
    const results = await Promise.all([doScan(entryVolunteer), doScan(legacyVolunteer), doScan(entryVolunteer)]);
    expect(results.filter((r) => r.body.result === "ok")).toHaveLength(1);
    expect((await adminDb().collection(COLLECTIONS.attendance).get()).size).toBe(1);
    expect((await adminDb().collection(COLLECTIONS.fests).doc("fest1").get()).data()?.stats.checkIns).toBe(1);
  });

  it("rejects a malformed request before touching anything", async () => {
    expect((await doScan(entryVolunteer, { memberKeys: ["not-a-key"] })).status).toBe(400);
    expect((await doMeal(mealVolunteer, { mealType: "brunch" })).status).toBe(400);
    expect((await doMeal(mealVolunteer, { servedOn: "tomorrow" })).status).toBe(400);
    expect((await doScan(entryVolunteer, { eventId: "../fests" })).status).toBe(400);
  });
});
