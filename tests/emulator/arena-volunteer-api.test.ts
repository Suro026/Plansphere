import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { membershipIdFor, type Duty, type FestRole } from "@/core/models/membership";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { syncMemberAccess } from "@/server/membership";
import { GET as listArenaVolunteers } from "@/app/api/admin/arenas/volunteers/route";
import { POST as assignToArena } from "@/app/api/admin/arenas/[id]/assign/route";
import { POST as createMatch } from "@/app/api/admin/matches/route";
import { PATCH as updateEvent } from "@/app/api/admin/events/[id]/route";
import { POST as matchAction } from "@/app/api/volunteer/matches/[id]/action/route";
import { callRoute, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * Arena volunteers, from the admin's picker to the public scoreboard, through the real handlers.
 *
 * The volunteer a fest rosters at an arena may hold their authority in either of two ways: the legacy fest-wide scope on
 * their profile (`festIds`), or an event role (a `festMembers` document with the scoring duty). The picker has to offer
 * both, the assignment has to be validated against the same rule the picker uses, and the scorer has to be held to the
 * arena they were assigned however their authority is held.
 */

let head: TestUser; // Event Super Admin of fest1 (a membership, not a legacy admin)
let legacyAdmin: TestUser; // pre-membership admin of fest1
let platform: TestUser;
let scorerA: TestUser; // event-role-only volunteer, scoring, ev1
let scorerB: TestUser; // event-role-only volunteer, scoring, ev1
let scorerEv2: TestUser; // event-role-only volunteer, scoring, ev2 only
let gateOnly: TestUser; // event-role-only volunteer, entry duty only
let suspendedScorer: TestUser;
let revokedScorer: TestUser;
let legacyVolunteer: TestUser; // fest-scoped volunteer
let legacyVolunteer2: TestUser;
let disabledLegacy: TestUser; // fest-scoped but disabled
let otherFestVolunteer: TestUser; // fest-scoped to fest2
let eventAdmin: TestUser; // admin of ev1 only
let student: TestUser;
let otherHead: TestUser; // head of fest2

const profile = (u: TestUser, role: string, festIds: string[] = [], extra: Record<string, unknown> = {}) =>
  adminDb().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, name: u.name, role, festIds, profileCompleted: true, mustChangePassword: false, disabled: false, createdAt: new Date(), updatedAt: new Date(), ...extra });

const grant = async (user: TestUser, role: FestRole, eventIds: string[], duties: Duty[] = [], festId = "fest1", status = "active") => {
  const id = membershipIdFor(festId, user.uid);
  await adminDb().collection(COLLECTIONS.festMembers).doc(id).set({ id, festId, userId: user.uid, role, eventIds, duties, status, createdBy: "seed", createdAt: new Date(), updatedAt: new Date() });
  await syncMemberAccess(user.uid);
};

beforeAll(async () => {
  await resetAuth();
  head = await mintUser({ name: "Event Head" });
  legacyAdmin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Legacy Admin" });
  platform = await mintUser({ role: "super_admin", name: "Platform Team" });
  scorerA = await mintUser({ name: "Scorer Alpha" });
  scorerB = await mintUser({ name: "Scorer Bravo" });
  scorerEv2 = await mintUser({ name: "Scorer Echo" });
  gateOnly = await mintUser({ name: "Gate Only" });
  suspendedScorer = await mintUser({ name: "Suspended Scorer" });
  revokedScorer = await mintUser({ name: "Revoked Scorer" });
  legacyVolunteer = await mintUser({ role: "volunteer", festIds: ["fest1"], name: "Legacy Volunteer" });
  legacyVolunteer2 = await mintUser({ role: "volunteer", festIds: ["fest1"], name: "Legacy Volunteer Two" });
  disabledLegacy = await mintUser({ role: "volunteer", festIds: ["fest1"], name: "Disabled Volunteer" });
  otherFestVolunteer = await mintUser({ role: "volunteer", festIds: ["fest2"], name: "Other Fest Volunteer" });
  eventAdmin = await mintUser({ name: "Event Admin" });
  student = await mintUser({ name: "Plain Student" });
  otherHead = await mintUser({ name: "Other Head" });
});

let arenaA: string;
let arenaB: string;

beforeEach(async () => {
  await resetFirestore();
  await seedFest({ ownerId: head.uid });
  await seedFest({ id: "fest2", slug: "other", name: "Other Fest", ownerId: otherHead.uid });
  await seedEvent();
  await seedEvent({ id: "ev2", slug: "robo", title: "Robotics" });
  await seedEvent({ id: "ev3", festId: "fest2", slug: "chess", title: "Chess" });

  for (const u of [head, scorerA, scorerB, scorerEv2, gateOnly, suspendedScorer, revokedScorer, eventAdmin, student, otherHead]) await profile(u, "student");
  await profile(platform, "super_admin");
  await profile(legacyAdmin, "admin", ["fest1"]);
  await profile(legacyVolunteer, "volunteer", ["fest1"]);
  await profile(legacyVolunteer2, "volunteer", ["fest1"]);
  await profile(disabledLegacy, "volunteer", ["fest1"], { disabled: true });
  await profile(otherFestVolunteer, "volunteer", ["fest2"]);

  await grant(head, "head", []);
  await grant(otherHead, "head", [], [], "fest2");
  await grant(scorerA, "volunteer", ["ev1"], ["scoring"]);
  await grant(scorerB, "volunteer", ["ev1"], ["scoring"]);
  await grant(scorerEv2, "volunteer", ["ev2"], ["scoring"]);
  await grant(gateOnly, "volunteer", ["ev1"], ["entry"]);
  await grant(suspendedScorer, "volunteer", ["ev1"], ["scoring"], "fest1", "suspended");
  await grant(revokedScorer, "volunteer", ["ev1"], ["scoring"], "fest1", "revoked");
  await grant(eventAdmin, "admin", ["ev1"]);

  for (const [id, name] of [["arenaA", "Arena A"], ["arenaB", "Arena B"]] as const) {
    await adminDb().collection(COLLECTIONS.arenas).doc(id).set({ id, festId: "fest1", name, active: true, createdBy: head.uid, createdAt: new Date(), updatedAt: new Date() });
  }
  arenaA = "arenaA";
  arenaB = "arenaB";
  await adminDb().collection(COLLECTIONS.arenas).doc("arenaX").set({ id: "arenaX", festId: "fest2", name: "Elsewhere", active: true, createdBy: otherHead.uid, createdAt: new Date(), updatedAt: new Date() });
});

const eligible = (who: TestUser | null, festId = "fest1") => callRoute(listArenaVolunteers, { path: `/api/admin/arenas/volunteers?festId=${festId}`, ...(who ? { token: who.idToken } : {}) });
const assign = (who: TestUser | null, arenaId: string, userId: string) =>
  callRoute(assignToArena, { path: `/api/admin/arenas/${arenaId}/assign`, method: "POST", params: { id: arenaId }, body: { userId }, ...(who ? { token: who.idToken } : {}) });
const shiftsOf = async (userId: string) => (await adminDb().collection(COLLECTIONS.shifts).where("userId", "==", userId).get()).docs.map((d) => d.data());

describe("the Assign-a-volunteer picker offers every eligible scorer", () => {
  it("lists event-role volunteers with the scoring duty AND fest-scoped volunteers, for the Event Super Admin", async () => {
    const res = await eligible(head);
    expect(res.status).toBe(200);
    const ids = res.body.volunteers.map((v: { id: string }) => v.id);
    for (const who of [scorerA, scorerB, scorerEv2, legacyVolunteer, legacyVolunteer2]) expect(ids, who.name).toContain(who.uid);
    const bySource = Object.fromEntries(res.body.volunteers.map((v: { id: string; source: string }) => [v.id, v.source]));
    expect(bySource[scorerA.uid]).toBe("event");
    expect(bySource[legacyVolunteer.uid]).toBe("fest");
  });

  it("leaves out everyone who could not score: no scoring duty, suspended, revoked, disabled, students, other fests, admins", async () => {
    const ids = (await eligible(head)).body.volunteers.map((v: { id: string }) => v.id);
    for (const who of [gateOnly, suspendedScorer, revokedScorer, disabledLegacy, otherFestVolunteer, student, eventAdmin, head, legacyAdmin]) expect(ids, who.name).not.toContain(who.uid);
  });

  it("shows each person once, with a name and e-mail, and nothing private", async () => {
    const { volunteers } = (await eligible(head)).body;
    const ids = volunteers.map((v: { id: string }) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of volunteers) expect(Object.keys(v).sort()).toEqual(["email", "id", "name", "source"]);
    expect(volunteers.find((v: { id: string }) => v.id === scorerA.uid)).toMatchObject({ name: "Scorer Alpha", email: scorerA.email });
  });

  it("gives the same answer to a legacy fest admin and to the platform", async () => {
    const forHead = (await eligible(head)).body.volunteers.map((v: { id: string }) => v.id).sort();
    expect((await eligible(legacyAdmin)).body.volunteers.map((v: { id: string }) => v.id).sort()).toEqual(forHead);
    expect((await eligible(platform)).body.volunteers.map((v: { id: string }) => v.id).sort()).toEqual(forHead);
  });

  it("is closed to everyone who does not manage the fest's arenas", async () => {
    expect((await eligible(null)).status).toBe(401);
    for (const who of [student, scorerA, legacyVolunteer, eventAdmin, otherHead]) expect((await eligible(who)).status, who.name).toBe(403);
    expect((await eligible(head, "fest2")).status).toBe(403);
    expect((await eligible(head, "nope")).status).toBe(403);
  });

  it("requires a fest id", async () => {
    expect((await callRoute(listArenaVolunteers, { path: "/api/admin/arenas/volunteers", token: head.idToken })).status).toBe(400);
  });
});

describe("assigning a volunteer to an arena", () => {
  it("rosters an event-role-only volunteer, with the admin as the creator and the volunteer's own name and e-mail", async () => {
    const res = await assign(head, arenaA, scorerA.uid);
    expect(res.status).toBe(201);
    const [shift] = await shiftsOf(scorerA.uid);
    expect(shift).toMatchObject({ festId: "fest1", userId: scorerA.uid, userName: "Scorer Alpha", userEmail: scorerA.email, duty: "scoring", post: arenaA, cancelled: false, createdBy: head.uid });
    expect(res.body.shift).toMatchObject({ userId: scorerA.uid, post: arenaA, duty: "scoring" });
  });

  it("rosters a fest-scoped volunteer just the same (existing behaviour)", async () => {
    expect((await assign(legacyAdmin, arenaA, legacyVolunteer.uid)).status).toBe(201);
    expect((await shiftsOf(legacyVolunteer.uid))[0]).toMatchObject({ post: arenaA, duty: "scoring", createdBy: legacyAdmin.uid });
    expect((await assign(platform, arenaB, legacyVolunteer2.uid)).status).toBe(201);
  });

  it("puts several volunteers on one arena, and one volunteer on several", async () => {
    for (const who of [scorerA, scorerB, legacyVolunteer]) expect((await assign(head, arenaA, who.uid)).status).toBe(201);
    expect((await assign(head, arenaB, scorerA.uid)).status).toBe(201);
    const onA = (await adminDb().collection(COLLECTIONS.shifts).where("post", "==", arenaA).get()).docs.map((d) => d.data().userId).sort();
    expect(onA).toEqual([scorerA.uid, scorerB.uid, legacyVolunteer.uid].sort());
    expect((await shiftsOf(scorerA.uid)).map((s) => s.post).sort()).toEqual([arenaA, arenaB]);
  });

  it("is idempotent: assigning the same person to the same arena again adds no second shift", async () => {
    expect((await assign(head, arenaA, scorerA.uid)).status).toBe(201);
    const again = await assign(head, arenaA, scorerA.uid);
    expect(again.status).toBe(200);
    expect(again.body.alreadyAssigned).toBe(true);
    expect(await shiftsOf(scorerA.uid)).toHaveLength(1);
  });

  it("refuses anyone who cannot score at this fest, whoever asks", async () => {
    for (const who of [gateOnly, suspendedScorer, revokedScorer, disabledLegacy, otherFestVolunteer, student, eventAdmin, legacyAdmin]) {
      const res = await assign(head, arenaA, who.uid);
      expect(res.status, who.name).toBe(422);
      expect(await shiftsOf(who.uid), who.name).toHaveLength(0);
    }
    expect((await assign(head, arenaA, "no-such-user")).status).toBe(422);
  });

  it("refuses an unknown arena, an arena of another fest, and anyone who does not manage this fest", async () => {
    expect((await assign(head, "nope", scorerA.uid)).status).toBe(404);
    expect((await assign(head, "arenaX", scorerA.uid)).status).toBe(403);
    expect((await assign(null, arenaA, scorerA.uid)).status).toBe(401);
    for (const who of [student, scorerA, legacyVolunteer, eventAdmin, otherHead]) {
      expect((await assign(who, arenaA, scorerB.uid)).status, who.name).toBe(403);
    }
    expect(await shiftsOf(scorerB.uid)).toHaveLength(0);
  });

  it("is audited, naming the arena and the volunteer", async () => {
    await assign(head, arenaA, scorerA.uid);
    const log = await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", "shift_created").get();
    expect(log.size).toBe(1);
    expect(log.docs[0]!.data()).toMatchObject({ actorId: head.uid, festId: "fest1", details: { arenaId: arenaA, userId: scorerA.uid } });
    expect(log.docs[0]!.data().summary).toContain("Arena A");
  });
});

describe("the scorer is held to the arena they were assigned", () => {
  let matchA: string; // ev1 at arenaA
  let matchB: string; // ev1 at arenaB
  let matchEv2: string; // ev2 at arenaA

  const act = (who: TestUser | null, id: string, body: Record<string, unknown>) =>
    callRoute(matchAction, { path: `/api/volunteer/matches/${id}/action`, method: "POST", params: { id }, body, ...(who ? { token: who.idToken } : {}) });

  beforeEach(async () => {
    for (const id of ["ev1", "ev2"]) {
      const res = await callRoute(updateEvent, { path: `/api/admin/events/${id}`, method: "PATCH", params: { id }, token: legacyAdmin.idToken, body: { liveEnabled: true, sportType: "football", matchConfig: { durationType: "time", halves: 2, minutesPerHalf: 20, maxPlayers: 11 } } });
      expect(res.status).toBe(200);
    }
    const make = async (eventId: string, arenaId: string) => {
      const res = await callRoute(createMatch, { path: "/api/admin/matches", method: "POST", token: legacyAdmin.idToken, body: { festId: "fest1", eventId, arenaId, homeTeam: { name: "Reds", isBye: false }, awayTeam: { name: "Blues", isBye: false } } });
      expect(res.status).toBe(201);
      return res.body.match.id as string;
    };
    matchA = await make("ev1", arenaA);
    matchB = await make("ev1", arenaB);
    matchEv2 = await make("ev2", arenaA);
  });

  it("an event-role-only volunteer scores the match at the arena they were assigned, and the public scoreboard document follows", async () => {
    expect((await assign(head, arenaA, scorerA.uid)).status).toBe(201);
    expect((await act(scorerA, matchA, { action: "start" })).status).toBe(200);
    for (const side of ["home", "home", "away"]) expect((await act(scorerA, matchA, { action: "score", scoreAction: { type: "goal", side } })).status).toBe(200);

    const live = (await adminDb().collection(COLLECTIONS.matches).doc(matchA).get()).data()!;
    expect(live.status).toBe("live");
    expect(live.score).toMatchObject({ home: 2, away: 1 });
    const log = await adminDb().collection(COLLECTIONS.matchLog).where("matchId", "==", matchA).get();
    expect(log.size).toBeGreaterThanOrEqual(3);
  });

  it("a fest-scoped volunteer still scores their arena, and only theirs", async () => {
    await assign(head, arenaA, legacyVolunteer.uid);
    expect((await act(legacyVolunteer, matchA, { action: "start" })).status).toBe(200);
    expect((await act(legacyVolunteer, matchB, { action: "start" })).status).toBe(403);
  });

  it("an event-role volunteer cannot score at an arena they were not assigned, even for their own sub-event", async () => {
    await assign(head, arenaA, scorerA.uid);
    await assign(head, arenaB, scorerB.uid);
    expect((await act(scorerA, matchB, { action: "start" })).status).toBe(403);
    expect((await act(scorerB, matchA, { action: "start" })).status).toBe(403);
    expect((await act(scorerB, matchB, { action: "start" })).status).toBe(200);
  });

  it("an event-role volunteer with the duty but no arena assignment cannot score", async () => {
    expect((await act(scorerA, matchA, { action: "start" })).status).toBe(403);
    expect((await adminDb().collection(COLLECTIONS.matches).doc(matchA).get()).data()!.status).toBe("upcoming");
  });

  it("the assignment never widens the membership: another sub-event, a cancelled shift or a lost duty still refuse", async () => {
    await assign(head, arenaA, scorerEv2.uid); // scoring, but only ev2
    expect((await act(scorerEv2, matchA, { action: "start" })).status).toBe(403); // ev1 match at their arena
    expect((await act(scorerEv2, matchEv2, { action: "start" })).status).toBe(200); // ev2 match at their arena

    await assign(head, arenaA, scorerA.uid);
    const shift = (await adminDb().collection(COLLECTIONS.shifts).where("userId", "==", scorerA.uid).get()).docs[0]!;
    await shift.ref.update({ cancelled: true });
    expect((await act(scorerA, matchA, { action: "start" })).status).toBe(403);
    await shift.ref.update({ cancelled: false });
    expect((await act(scorerA, matchA, { action: "start" })).status).toBe(200);

    await grant(scorerA, "volunteer", ["ev1"], ["entry"]); // the duty is taken away; the old shift remains
    expect((await act(scorerA, matchA, { action: "pause" })).status).toBe(403);
  });

  it("refuses everyone who is not an assigned scorer: gate-only, suspended, revoked, student, outsiders and anonymous", async () => {
    for (const who of [gateOnly, suspendedScorer, revokedScorer, student, otherFestVolunteer, otherHead]) expect((await act(who, matchA, { action: "start" })).status, who.name).toBe(403);
    expect((await act(null, matchB, { action: "start" })).status).toBe(401);
    expect((await adminDb().collection(COLLECTIONS.matches).doc(matchA).get()).data()!.status).toBe("upcoming");
  });

  it("an event admin scores their own sub-event through the membership itself, as before, and not another", async () => {
    expect((await act(eventAdmin, matchA, { action: "start" })).status).toBe(200);
    expect((await act(eventAdmin, matchEv2, { action: "start" })).status).toBe(403);
  });

  it("the head, a legacy admin and the platform still score any arena without a shift", async () => {
    expect((await act(head, matchB, { action: "start" })).status).toBe(200);
    expect((await act(legacyAdmin, matchB, { action: "pause" })).status).toBe(200);
    expect((await act(platform, matchB, { action: "resume" })).status).toBe(200);
  });
});
