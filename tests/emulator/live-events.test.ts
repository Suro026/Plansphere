import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { POST as createArena } from "@/app/api/admin/arenas/route";
import { PATCH as updateArena, DELETE as deleteArena } from "@/app/api/admin/arenas/[id]/route";
import { POST as generateBracket } from "@/app/api/admin/events/[id]/bracket/route";
import { POST as createMatch } from "@/app/api/admin/matches/route";
import { PATCH as updateMatch } from "@/app/api/admin/matches/[id]/route";
import { POST as matchAction } from "@/app/api/volunteer/matches/[id]/action/route";
import { PATCH as updateEvent } from "@/app/api/admin/events/[id]/route";
import { callRoute, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * Part 7 — the Live Event & Sports Engine, against the real handlers.
 *
 * Covers arena CRUD, bracket generation with byes, the volunteer scorer's
 * arena-scoping (the one thing that cannot be checked by a Firestore rule),
 * the full match lifecycle including bracket advancement and undo, and the
 * notifications a match's start and a tournament's champion send out.
 * `firestore-rules.test.ts` covers the public-read / server-only-write side
 * separately, since that is a rules concern, not a route concern.
 */

let owner: TestUser;
let admin: TestUser;
let otherAdmin: TestUser;
let volunteerA: TestUser; // scoring shift at arena1
let volunteerB: TestUser; // scoring shift at arena2
let student: TestUser;

beforeAll(async () => {
  await resetAuth();
  owner = await mintUser({ role: "super_admin", name: "Platform Owner" });
  admin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Fest Admin" });
  otherAdmin = await mintUser({ role: "admin", festIds: ["fest2"], name: "Other Admin" });
  volunteerA = await mintUser({ role: "volunteer", festIds: ["fest1"], name: "Vol A" });
  volunteerB = await mintUser({ role: "volunteer", festIds: ["fest1"], name: "Vol B" });
  student = await mintUser({ name: "Stu Dent" });
});

const enableLive = async (over: Record<string, unknown> = {}) =>
  callRoute(updateEvent, {
    path: "/api/admin/events/ev1",
    method: "PATCH",
    params: { id: "ev1" },
    token: admin.idToken,
    body: { liveEnabled: true, sportType: "football", matchConfig: { durationType: "time", halves: 2, minutesPerHalf: 20, maxPlayers: 11 }, ...over },
  });

beforeEach(async () => {
  await resetFirestore();
  for (const user of [owner, admin, otherAdmin, volunteerA, volunteerB, student]) {
    await adminDb()
      .collection(COLLECTIONS.users)
      .doc(user.uid)
      .set({
        id: user.uid,
        email: user.email,
        name: user.name,
        role: user.role,
        festIds: user.uid === otherAdmin.uid ? ["fest2"] : user.role === "student" ? [] : ["fest1"],
        profileCompleted: true,
        mustChangePassword: false,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
  }
  await seedFest();
  await seedEvent();
});

describe("arenas", () => {
  it("requires match:manage and the caller's own fest scope", async () => {
    const noAuth = await callRoute(createArena, { path: "/api/admin/arenas", method: "POST", body: { festId: "fest1", name: "Arena A" } });
    expect(noAuth.status).toBe(401);

    const asVolunteer = await callRoute(createArena, { path: "/api/admin/arenas", method: "POST", token: volunteerA.idToken, body: { festId: "fest1", name: "Arena A" } });
    expect(asVolunteer.status).toBe(403);

    const wrongFest = await callRoute(createArena, { path: "/api/admin/arenas", method: "POST", token: otherAdmin.idToken, body: { festId: "fest1", name: "Arena A" } });
    expect(wrongFest.status).toBe(403);
  });

  it("creates, updates and deletes an arena, all audited", async () => {
    const created = await callRoute(createArena, { path: "/api/admin/arenas", method: "POST", token: admin.idToken, body: { festId: "fest1", name: "Arena A", location: "North lawn" } });
    expect(created.status).toBe(201);
    const arenaId = created.body.arena.id;

    const updated = await callRoute(updateArena, { path: `/api/admin/arenas/${arenaId}`, method: "PATCH", params: { id: arenaId }, token: admin.idToken, body: { active: false } });
    expect(updated.status).toBe(200);
    expect(updated.body.arena.active).toBe(false);

    const removed = await callRoute(deleteArena, { path: `/api/admin/arenas/${arenaId}`, method: "DELETE", params: { id: arenaId }, token: admin.idToken });
    expect(removed.status).toBe(200);

    const auditSnap = await adminDb().collection(COLLECTIONS.auditLog).where("subjectId", "==", arenaId).get();
    expect(auditSnap.docs.map((d) => d.data().action)).toEqual(expect.arrayContaining(["arena_created", "arena_updated", "arena_deleted"]));
  });

  it("refuses to delete an arena with matches assigned", async () => {
    const created = await callRoute(createArena, { path: "/api/admin/arenas", method: "POST", token: admin.idToken, body: { festId: "fest1", name: "Arena A" } });
    const arenaId = created.body.arena.id;
    await enableLive();
    await callRoute(createMatch, { path: "/api/admin/matches", method: "POST", token: admin.idToken, body: { festId: "fest1", eventId: "ev1", arenaId } });

    const removed = await callRoute(deleteArena, { path: `/api/admin/arenas/${arenaId}`, method: "DELETE", params: { id: arenaId }, token: admin.idToken });
    expect(removed.status).toBe(422);
  });
});

describe("admin match edits", () => {
  it("reassigns a match's arena and refuses a fest mismatch", async () => {
    await enableLive();
    const a1 = await callRoute(createArena, { path: "/api/admin/arenas", method: "POST", token: admin.idToken, body: { festId: "fest1", name: "Arena A" } });
    const created = await callRoute(createMatch, { path: "/api/admin/matches", method: "POST", token: admin.idToken, body: { festId: "fest1", eventId: "ev1" } });
    const matchId = created.body.match.id;

    const moved = await callRoute(updateMatch, { path: `/api/admin/matches/${matchId}`, method: "PATCH", params: { id: matchId }, token: admin.idToken, body: { arenaId: a1.body.arena.id } });
    expect(moved.status).toBe(200);
    expect(moved.body.match.arenaName).toBe("Arena A");

    const wrongFest = await callRoute(updateMatch, { path: `/api/admin/matches/${matchId}`, method: "PATCH", params: { id: matchId }, token: otherAdmin.idToken, body: { arenaId: a1.body.arena.id } });
    expect(wrongFest.status).toBe(403);
  });
});

describe("bracket generation", () => {
  const confirmReg = async (id: string, over: Record<string, unknown> = {}) =>
    adminDb()
      .collection(COLLECTIONS.registrations)
      .doc(id)
      .set({
        id, eventId: "ev1", festId: "fest1", userId: `u-${id}`, type: "solo", status: "confirmed", seats: 1,
        ticketCode: `PS-${id.toUpperCase().padEnd(10, "0")}`, members: [{ name: id, email: `${id}@x.test`, isLeader: true, inviteStatus: "accepted" }],
        memberEmails: [`${id}@x.test`], eventTitle: "Capture the Flag", userName: id, userEmail: `${id}@x.test`,
        answers: {}, createdAt: new Date(), updatedAt: new Date(), ...over,
      });

  it("requires liveEnabled and a sportType before generating", async () => {
    await confirmReg("r1");
    await confirmReg("r2");
    const res = await callRoute(generateBracket, { path: "/api/admin/events/ev1/bracket", method: "POST", params: { id: "ev1" }, token: admin.idToken, body: { tournamentType: "knockout" } });
    expect(res.status).toBe(422);
  });

  it("generates a knockout bracket with byes for 5 confirmed entries", async () => {
    for (const id of ["r1", "r2", "r3", "r4", "r5"]) await confirmReg(id);
    await enableLive();

    const res = await callRoute(generateBracket, { path: "/api/admin/events/ev1/bracket", method: "POST", params: { id: "ev1" }, token: admin.idToken, body: { tournamentType: "knockout" } });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(7); // 4 + 2 + 1, bracket of 8

    const snap = await adminDb().collection(COLLECTIONS.matches).where("eventId", "==", "ev1").get();
    expect(snap.size).toBe(7);
    const round1 = snap.docs.map((d) => d.data()).filter((m) => m.round === 1);
    const byeMatches = round1.filter((m) => m.homeTeam?.isBye || m.awayTeam?.isBye);
    expect(byeMatches).toHaveLength(3);
    expect(byeMatches.every((m) => m.status === "completed" && m.winner)).toBe(true);
  });

  it("generates a full round-robin with no byes for an exact bracket size", async () => {
    for (const id of ["r1", "r2", "r3", "r4"]) await confirmReg(id);
    await enableLive();
    const res = await callRoute(generateBracket, { path: "/api/admin/events/ev1/bracket", method: "POST", params: { id: "ev1" }, token: admin.idToken, body: { tournamentType: "round_robin" } });
    expect(res.body.created).toBe(6);
  });

  it("refuses to regenerate once a match has started", async () => {
    for (const id of ["r1", "r2"]) await confirmReg(id);
    await enableLive();
    await callRoute(generateBracket, { path: "/api/admin/events/ev1/bracket", method: "POST", params: { id: "ev1" }, token: admin.idToken, body: { tournamentType: "knockout" } });
    const matchSnap = await adminDb().collection(COLLECTIONS.matches).where("eventId", "==", "ev1").limit(1).get();
    const liveMatchId = matchSnap.docs[0]!.id;
    await callRoute(matchAction, { path: `/api/volunteer/matches/${liveMatchId}/action`, method: "POST", params: { id: liveMatchId }, token: admin.idToken, body: { action: "start" } });
    const again = await callRoute(generateBracket, { path: "/api/admin/events/ev1/bracket", method: "POST", params: { id: "ev1" }, token: admin.idToken, body: { tournamentType: "knockout" } });
    expect(again.status).toBe(422);
  });
});

describe("volunteer live scoring — arena scoping", () => {
  let arenaId1: string;
  let arenaId2: string;
  let matchId: string;

  beforeEach(async () => {
    const a1 = await callRoute(createArena, { path: "/api/admin/arenas", method: "POST", token: admin.idToken, body: { festId: "fest1", name: "Arena A" } });
    const a2 = await callRoute(createArena, { path: "/api/admin/arenas", method: "POST", token: admin.idToken, body: { festId: "fest1", name: "Arena B" } });
    arenaId1 = a1.body.arena.id;
    arenaId2 = a2.body.arena.id;
    await enableLive();
    const match = await callRoute(createMatch, { path: "/api/admin/matches", method: "POST", token: admin.idToken, body: { festId: "fest1", eventId: "ev1", arenaId: arenaId1, homeTeam: { name: "Alpha", isBye: false }, awayTeam: { name: "Beta", isBye: false } } });
    matchId = match.body.match.id;

    await adminDb().collection(COLLECTIONS.shifts).doc("shiftA").set({
      id: "shiftA", festId: "fest1", userId: volunteerA.uid, userName: volunteerA.name, userEmail: volunteerA.email,
      post: arenaId1, duty: "scoring", date: "2026-09-26", startTime: "09:00", endTime: "18:00", eventIds: [], cancelled: false,
      createdBy: admin.uid, createdAt: new Date(), updatedAt: new Date(),
    });
    await adminDb().collection(COLLECTIONS.shifts).doc("shiftB").set({
      id: "shiftB", festId: "fest1", userId: volunteerB.uid, userName: volunteerB.name, userEmail: volunteerB.email,
      post: arenaId2, duty: "scoring", date: "2026-09-26", startTime: "09:00", endTime: "18:00", eventIds: [], cancelled: false,
      createdBy: admin.uid, createdAt: new Date(), updatedAt: new Date(),
    });
  });

  it("lets the assigned volunteer start and score the match at their arena", async () => {
    const res = await callRoute(matchAction, { path: `/api/volunteer/matches/${matchId}/action`, method: "POST", params: { id: matchId }, token: volunteerA.idToken, body: { action: "start" } });
    expect(res.status).toBe(200);
    expect(res.body.match.status).toBe("live");
  });

  it("refuses a volunteer assigned to a different arena", async () => {
    const res = await callRoute(matchAction, { path: `/api/volunteer/matches/${matchId}/action`, method: "POST", params: { id: matchId }, token: volunteerB.idToken, body: { action: "start" } });
    expect(res.status).toBe(403);
  });

  it("refuses a volunteer with no scoring shift at all", async () => {
    const res = await callRoute(matchAction, { path: `/api/volunteer/matches/${matchId}/action`, method: "POST", params: { id: matchId }, token: student.idToken, body: { action: "start" } });
    expect(res.status).toBe(403);
  });

  it("lets an admin score any match regardless of arena assignment", async () => {
    const res = await callRoute(matchAction, { path: `/api/volunteer/matches/${matchId}/action`, method: "POST", params: { id: matchId }, token: admin.idToken, body: { action: "start" } });
    expect(res.status).toBe(200);
  });

  it("refuses an admin from a different fest", async () => {
    const res = await callRoute(matchAction, { path: `/api/volunteer/matches/${matchId}/action`, method: "POST", params: { id: matchId }, token: otherAdmin.idToken, body: { action: "start" } });
    expect(res.status).toBe(403);
  });
});

describe("match lifecycle — scoring, undo, finishing, bracket advancement", () => {
  let matchId: string;
  let finalId: string;

  beforeEach(async () => {
    await enableLive();
    // Build a 2-match bracket by hand: two semis feeding one final, so
    // finishing a semi should advance the winner into the final.
    const semi = await callRoute(createMatch, { path: "/api/admin/matches", method: "POST", token: admin.idToken, body: { festId: "fest1", eventId: "ev1", homeTeam: { name: "Alpha", isBye: false }, awayTeam: { name: "Beta", isBye: false } } });
    matchId = semi.body.match.id;
    const final = await callRoute(createMatch, { path: "/api/admin/matches", method: "POST", token: admin.idToken, body: { festId: "fest1", eventId: "ev1" } });
    finalId = final.body.match.id;
    await adminDb().collection(COLLECTIONS.matches).doc(matchId).update({ nextMatchId: finalId, nextMatchSlot: "home" });

    await adminDb().collection(COLLECTIONS.registrations).doc("r1").set({
      id: "r1", eventId: "ev1", festId: "fest1", userId: student.uid, type: "solo", status: "confirmed", seats: 1,
      ticketCode: "PS-AAAAAAAAAA", members: [{ name: student.name, email: student.email, isLeader: true, inviteStatus: "accepted" }],
      memberEmails: [student.email], eventTitle: "Capture the Flag", userName: student.name, userEmail: student.email,
      answers: {}, createdAt: new Date(), updatedAt: new Date(),
    });
  });

  const act = (id: string, body: Record<string, unknown>, token = admin.idToken) => callRoute(matchAction, { path: `/api/volunteer/matches/${id}/action`, method: "POST", params: { id }, token, body });

  it("starts, scores goals, and finishes with an explicit winner", async () => {
    await act(matchId, { action: "start" });
    await act(matchId, { action: "score", scoreAction: { type: "goal", side: "home" } });
    await act(matchId, { action: "score", scoreAction: { type: "goal", side: "home" } });
    const scored = await act(matchId, { action: "score", scoreAction: { type: "goal", side: "away" } });
    expect(scored.body.match.score).toMatchObject({ home: 2, away: 1 });

    const finish = await act(matchId, { action: "finish" }); // no explicit winner needed — home leads
    expect(finish.status).toBe(200);
    expect(finish.body.match.status).toBe("completed");
    expect(finish.body.match.winner).toBe("home");
  });

  it("refuses to finish a tied match without an explicit winner", async () => {
    await act(matchId, { action: "start" });
    await act(matchId, { action: "score", scoreAction: { type: "goal", side: "home" } });
    await act(matchId, { action: "score", scoreAction: { type: "goal", side: "away" } });
    const tied = await act(matchId, { action: "finish" });
    expect(tied.status).toBe(400);
    const withWinner = await act(matchId, { action: "finish", winner: "away" });
    expect(withWinner.status).toBe(200);
    expect(withWinner.body.match.winner).toBe("away");
  });

  it("advances the winner into the next match on finish", async () => {
    await act(matchId, { action: "start" });
    await act(matchId, { action: "score", scoreAction: { type: "goal", side: "home" } });
    await act(matchId, { action: "finish" });

    const finalSnap = await adminDb().collection(COLLECTIONS.matches).doc(finalId).get();
    expect(finalSnap.data()!.homeTeam.name).toBe("Alpha");
  });

  it("undo reverts the score by replaying the log, and marks the entry undone rather than deleting it", async () => {
    await act(matchId, { action: "start" });
    await act(matchId, { action: "score", scoreAction: { type: "goal", side: "home" } });
    const afterScore = await act(matchId, { action: "score", scoreAction: { type: "goal", side: "home" } });
    expect(afterScore.body.match.score.home).toBe(2);

    const undone = await act(matchId, { action: "undo" });
    expect(undone.body.match.score.home).toBe(1);

    const logSnap = await adminDb().collection(COLLECTIONS.matchLog).where("matchId", "==", matchId).get();
    const entries = logSnap.docs.map((d) => d.data());
    expect(entries).toHaveLength(2);
    expect(entries.filter((e) => e.undone)).toHaveLength(1);
  });

  it("refuses undo with nothing to undo", async () => {
    await act(matchId, { action: "start" });
    const res = await act(matchId, { action: "undo" });
    expect(res.status).toBe(422);
  });

  it("cannot score, finish or cancel a match that has already finished", async () => {
    await act(matchId, { action: "start" });
    await act(matchId, { action: "score", scoreAction: { type: "goal", side: "home" } });
    await act(matchId, { action: "finish" });

    expect((await act(matchId, { action: "score", scoreAction: { type: "goal", side: "home" } })).status).toBe(422);
    expect((await act(matchId, { action: "finish" })).status).toBe(422);
    expect((await act(matchId, { action: "cancel" })).status).toBe(422);
  });

  it("pauses and resumes a live match", async () => {
    await act(matchId, { action: "start" });
    const paused = await act(matchId, { action: "pause" });
    expect(paused.body.match.paused).toBe(true);
    const resumed = await act(matchId, { action: "resume" });
    expect(resumed.body.match.paused).toBe(false);
  });

  it("records every action to the audit log", async () => {
    await act(matchId, { action: "start" });
    await act(matchId, { action: "score", scoreAction: { type: "goal", side: "home" } });
    await act(matchId, { action: "finish" });
    const auditSnap = await adminDb().collection(COLLECTIONS.auditLog).where("subjectId", "==", matchId).get();
    const actions = auditSnap.docs.map((d) => d.data().action);
    expect(actions).toEqual(expect.arrayContaining(["match_started", "match_score_updated", "match_finished"]));
  });

  it("sends a match-starting notification to registered participants", async () => {
    await act(matchId, { action: "start" });
    const notifSnap = await adminDb().collection(COLLECTIONS.notifications).where("userId", "==", student.uid).where("type", "==", "match_starting").get();
    expect(notifSnap.size).toBe(1);
  });

  it("declares a champion and notifies participants only when the final is finished", async () => {
    // Finishing the semi (which has a nextMatchId) must not declare a champion.
    await act(matchId, { action: "start" });
    await act(matchId, { action: "score", scoreAction: { type: "goal", side: "home" } });
    await act(matchId, { action: "finish" });
    let champSnap = await adminDb().collection(COLLECTIONS.notifications).where("type", "==", "champion_declared").get();
    expect(champSnap.size).toBe(0);

    // The final (no nextMatchId) declares a champion on finish.
    await act(finalId, { action: "start" });
    await act(finalId, { action: "score", scoreAction: { type: "goal", side: "home" } });
    const finished = await act(finalId, { action: "finish" });
    expect(finished.body.match.winner).toBe("home");

    champSnap = await adminDb().collection(COLLECTIONS.notifications).where("type", "==", "champion_declared").get();
    expect(champSnap.size).toBe(1);

    const finalStartedSnap = await adminDb().collection(COLLECTIONS.notifications).where("type", "==", "tournament_final_started").get();
    expect(finalStartedSnap.size).toBe(1);
  });

  it("auto-completes and declares a champion straight from a scoring action once a config-driven target is reached", async () => {
    await callRoute(updateEvent, { path: "/api/admin/events/ev1", method: "PATCH", params: { id: "ev1" }, token: admin.idToken, body: { matchConfig: { durationType: "points", targetPoints: 2, maxPlayers: 11 }, sportType: "quiz" } });
    await adminDb().collection(COLLECTIONS.matches).doc(finalId).update({ matchConfig: { durationType: "points", targetPoints: 2, maxPlayers: 11 }, sportType: "quiz" });

    await act(finalId, { action: "start" });
    await act(finalId, { action: "score", scoreAction: { type: "point", side: "home" } });
    const winning = await act(finalId, { action: "score", scoreAction: { type: "point", side: "home" } });
    expect(winning.body.match.status).toBe("completed");
    expect(winning.body.match.winner).toBe("home");

    const champSnap = await adminDb().collection(COLLECTIONS.notifications).where("type", "==", "champion_declared").get();
    expect(champSnap.size).toBe(1);
  });
});

describe("every sport engine scores a freshly created match", () => {
  // Matches used to start with `detail: {}`, which the cards (football), overs
  // (cricket), sets (volleyball) and round-points (robo fight) engines cannot
  // read — the first such tap was a 500. They now start from the engine's own state.
  const act = (id: string, body: Record<string, unknown>) =>
    callRoute(matchAction, { path: `/api/volunteer/matches/${id}/action`, method: "POST", params: { id }, token: admin.idToken, body });

  const freshMatch = async (sportType: string, matchConfig: Record<string, unknown>) => {
    await callRoute(updateEvent, { path: "/api/admin/events/ev1", method: "PATCH", params: { id: "ev1" }, token: admin.idToken, body: { liveEnabled: true, sportType, matchConfig } });
    const created = await callRoute(createMatch, { path: "/api/admin/matches", method: "POST", token: admin.idToken, body: { festId: "fest1", eventId: "ev1", homeTeam: { name: "Alpha", isBye: false }, awayTeam: { name: "Beta", isBye: false } } });
    expect(created.status).toBe(201);
    return created.body.match.id as string;
  };

  it("football: a card is recorded", async () => {
    const id = await freshMatch("football", { durationType: "time", halves: 2, minutesPerHalf: 20, maxPlayers: 11 });
    const res = await act(id, { action: "score", scoreAction: { type: "yellow_card", side: "home" } });
    expect(res.status).toBe(200);
    expect(res.body.match.score.detail.yellow.home).toBe(1);
  });

  it("cricket: runs and a wicket are recorded against the batting side", async () => {
    const id = await freshMatch("cricket", { durationType: "overs", overs: 5, maxPlayers: 8 });
    const run = await act(id, { action: "score", scoreAction: { type: "run", payload: { runs: 4 } } });
    expect(run.status).toBe(200);
    expect(run.body.match.score.displayHome).toBe("4/0");
    const wicket = await act(id, { action: "score", scoreAction: { type: "wicket" } });
    expect(wicket.status).toBe(200);
    expect(wicket.body.match.score.displayHome).toBe("4/1");
  });

  it("volleyball: a point is recorded in the current set", async () => {
    const id = await freshMatch("volleyball", { durationType: "sets", sets: 3, pointsPerSet: 25, maxPlayers: 6 });
    const res = await act(id, { action: "score", scoreAction: { type: "point", side: "away" } });
    expect(res.status).toBe(200);
    expect(res.body.match.score.detail.currentSet.away).toBe(1);
  });

  it("robo fight: points accumulate before any round is won", async () => {
    const id = await freshMatch("Robo Fight", { durationType: "rounds", rounds: 3, maxPlayers: 5 });
    const res = await act(id, { action: "score", scoreAction: { type: "point", side: "home", payload: { value: 5 } } });
    expect(res.status).toBe(200);
    expect(res.body.match.score.detail.totalPoints.home).toBe(5);
  });

  it("a match that predates this fix (empty detail) is scored too", async () => {
    const id = await freshMatch("football", { durationType: "time", halves: 2, minutesPerHalf: 20, maxPlayers: 11 });
    await adminDb().collection(COLLECTIONS.matches).doc(id).update({ "score.detail": {} });
    const res = await act(id, { action: "score", scoreAction: { type: "red_card", side: "away" } });
    expect(res.status).toBe(200);
    expect(res.body.match.score.detail.red.away).toBe(1);
  });
});
