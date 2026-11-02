import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, deleteDoc, where } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

/**
 * The volunteer's own roster and the arena side of the Live Event Engine, as the browser sees it.
 *
 * A volunteer's phone reads its OWN shifts straight from Firestore (`subscribeForUser`: festId + userId). For an account
 * that works a fest through an event role (a `festMembers` document, token claim `fm`) and has no legacy fest scope, the
 * rules must let that one query through - and nothing wider. These pin both halves: the volunteer sees their arena
 * assignment, and still cannot read a colleague's shifts, the fest roster, or write anything.
 */

let env: RulesTestEnvironment;
const [host = "127.0.0.1", port = "8080"] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");

/** An event-role account: `role` is the ceiling the claim writer raises the token to, `br` is what the account itself is. */
const member = (uid: string, role: string, extra: Record<string, unknown> = {}) => ({ uid, email: `${uid}@plansphere.test`, email_verified: true, role, br: "student", festIds: [] as string[], fm: ["fest1"], ...extra });
const head = member("head1", "admin");
const scorerA = member("scorerA", "volunteer"); // event-role-only, scoring, assigned to arena1
const scorerB = member("scorerB", "volunteer"); // event-role-only, scoring, assigned to arena2
const gateOnly = member("gate1", "volunteer"); // event-role-only, entry duty, no shift
const suspended = member("susp1", "volunteer");
const revoked = member("rev1", "volunteer");
const elsewhere = member("else1", "volunteer", { fm: ["fest2"] }); // an event role on a DIFFERENT main event
const legacyVolunteer = { uid: "leg1", email: "leg1@plansphere.test", email_verified: true, role: "volunteer", festIds: ["fest1"] };
const legacyOther = { uid: "leg2", email: "leg2@plansphere.test", email_verified: true, role: "volunteer", festIds: ["fest1"] };
const student = { uid: "stu1", email: "stu1@plansphere.test", email_verified: true, role: "student", festIds: [] as string[] };

const as = (claims: { uid: string } & Record<string, unknown>) => {
  const { uid, ...token } = claims;
  return env.authenticatedContext(uid, token).firestore();
};
const anon = () => env.unauthenticatedContext().firestore();
const shifts = (who: ReturnType<typeof as>) => collection(who, "shifts");
const mine = (who: { uid: string } & Record<string, unknown>, festId = "fest1") => query(shifts(as(who)), where("festId", "==", festId), where("userId", "==", who.uid));

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
    const fest = (id: string) => ({ id, slug: id, name: id, status: "published", organizationName: "T", startDate: "2026-09-25", endDate: "2026-09-27", stats: { events: 1, registrations: 0, checkIns: 0 }, createdAt: now, updatedAt: now });
    await setDoc(doc(db, "fests", "fest1"), fest("fest1"));
    await setDoc(doc(db, "fests", "fest2"), fest("fest2"));
    await setDoc(doc(db, "events", "ev1"), { id: "ev1", festId: "fest1", slug: "football", title: "Football", status: "published", eventType: "team", capacity: 10, registeredCount: 0, createdAt: now, updatedAt: now });

    const row = (uid: string, role: string, eventIds: string[], status = "active", duties: string[] = []) =>
      setDoc(doc(db, "festMembers", `fest1__${uid}`), { id: `fest1__${uid}`, festId: "fest1", userId: uid, role, eventIds, duties, status, createdBy: "head1", createdAt: now, updatedAt: now });
    await row("head1", "head", []);
    await row("scorerA", "volunteer", ["ev1"], "active", ["scoring"]);
    await row("scorerB", "volunteer", ["ev1"], "active", ["scoring"]);
    await row("gate1", "volunteer", ["ev1"], "active", ["entry"]);
    await row("susp1", "volunteer", ["ev1"], "suspended", ["scoring"]);
    await row("rev1", "volunteer", ["ev1"], "revoked", ["scoring"]);
    await setDoc(doc(db, "festMembers", "fest2__else1"), { id: "fest2__else1", festId: "fest2", userId: "else1", role: "volunteer", eventIds: [], duties: ["scoring"], status: "active", createdBy: "x", createdAt: now, updatedAt: now });

    await setDoc(doc(db, "arenas", "arena1"), { id: "arena1", festId: "fest1", name: "Arena A", active: true, createdBy: "head1", createdAt: now, updatedAt: now });
    await setDoc(doc(db, "arenas", "arena2"), { id: "arena2", festId: "fest1", name: "Arena B", active: true, createdBy: "head1", createdAt: now, updatedAt: now });
    const shift = (id: string, userId: string, post: string, festId = "fest1") =>
      setDoc(doc(db, "shifts", id), { id, festId, userId, userName: userId, userEmail: `${userId}@plansphere.test`, post, duty: "scoring", date: "2026-09-26", startTime: "00:00", endTime: "23:59", eventIds: [], cancelled: false, createdBy: "head1", createdAt: now, updatedAt: now });
    await shift("shA", "scorerA", "arena1");
    await shift("shB", "scorerB", "arena2");
    await shift("shLeg", "leg1", "arena1");
    await shift("shLeg2", "leg2", "arena2");
    await shift("shElse", "else1", "arena9", "fest2");
    await setDoc(doc(db, "matches", "match1"), {
      id: "match1", festId: "fest1", eventId: "ev1", round: 1, roundLabel: "Final", matchIndex: 0, arenaId: "arena1", status: "live", paused: false,
      homeTeam: { name: "Reds" }, awayTeam: { name: "Blues" }, score: { home: 1, away: 0, displayHome: "1", displayAway: "0" }, createdAt: now, updatedAt: now,
    });
  });
});

describe("an event-role-only volunteer reads their own arena assignment", () => {
  it("lists their own shifts for the fest they hold the role on (the query the volunteer's phone makes)", async () => {
    await assertSucceeds(getDocs(mine(scorerA)));
    await assertSucceeds(getDocs(mine(scorerB)));
  });

  it("gets their own shift document", async () => {
    await assertSucceeds(getDoc(doc(as(scorerA), "shifts", "shA")));
  });

  it("returns exactly their own assignment, not anyone else's", async () => {
    const snap = await getDocs(mine(scorerA));
    const ids = snap.docs.map((d) => d.id);
    if (ids.join() !== "shA") throw new Error(`expected only shA, got ${ids.join()}`);
  });

  it("cannot read another volunteer's shifts: not by id, not by asking for their user id, not by listing the fest roster", async () => {
    await assertFails(getDoc(doc(as(scorerA), "shifts", "shB")));
    await assertFails(getDoc(doc(as(scorerA), "shifts", "shLeg")));
    await assertFails(getDocs(query(shifts(as(scorerA)), where("festId", "==", "fest1"), where("userId", "==", "scorerB"))));
    await assertFails(getDocs(query(shifts(as(scorerA)), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(shifts(as(scorerA)), where("userId", "==", "scorerB"))));
    await assertFails(getDocs(shifts(as(scorerA))));
  });

  it("cannot read shifts of a fest they hold no event role on, even their own", async () => {
    await assertFails(getDocs(mine(scorerA, "fest2")));
    await assertFails(getDocs(mine(elsewhere, "fest1")));
    await assertSucceeds(getDocs(mine(elsewhere, "fest2")));
  });

  it("loses the read the moment the membership is suspended or revoked", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const now = new Date();
      await setDoc(doc(ctx.firestore(), "shifts", "shSusp"), { id: "shSusp", festId: "fest1", userId: "susp1", userName: "S", userEmail: "s@plansphere.test", post: "arena1", duty: "scoring", date: "2026-09-26", startTime: "00:00", endTime: "23:59", eventIds: [], cancelled: false, createdBy: "head1", createdAt: now, updatedAt: now });
      await setDoc(doc(ctx.firestore(), "shifts", "shRev"), { id: "shRev", festId: "fest1", userId: "rev1", userName: "R", userEmail: "r@plansphere.test", post: "arena1", duty: "scoring", date: "2026-09-26", startTime: "00:00", endTime: "23:59", eventIds: [], cancelled: false, createdBy: "head1", createdAt: now, updatedAt: now });
    });
    await assertFails(getDocs(mine(suspended)));
    await assertFails(getDocs(mine(revoked)));
  });

  it("is refused while the temporary password is still in force", async () => {
    await assertFails(getDocs(mine({ ...scorerA, mustChangePassword: true })));
  });

  it("can never write a shift: not assign themselves to an arena, not edit or delete their own", async () => {
    const now = new Date();
    await assertFails(setDoc(doc(as(scorerA), "shifts", "mine"), { id: "mine", festId: "fest1", userId: "scorerA", userName: "A", userEmail: "a@plansphere.test", post: "arena2", duty: "scoring", date: "2026-09-26", startTime: "00:00", endTime: "23:59", eventIds: [], createdBy: "scorerA", createdAt: now, updatedAt: now }));
    await assertFails(updateDoc(doc(as(scorerA), "shifts", "shA"), { post: "arena2" }));
    await assertFails(deleteDoc(doc(as(scorerA), "shifts", "shA")));
  });

  it("a gate-only member with no shift lists an empty roster, but the read is still allowed", async () => {
    const snap = await assertSucceeds(getDocs(mine(gateOnly)));
    if (snap.size !== 0) throw new Error("a member with no shift should list nothing");
  });
});

describe("fest-scoped (legacy) volunteers keep what they had", () => {
  it("lists their own shifts and the fest roster for the team screen, in their own fest only", async () => {
    await assertSucceeds(getDocs(mine(legacyVolunteer)));
    await assertSucceeds(getDocs(query(shifts(as(legacyVolunteer)), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(shifts(as(legacyVolunteer)), where("festId", "==", "fest2"))));
    await assertFails(getDocs(mine(legacyVolunteer, "fest2")));
    // The Team screen shows who else is rostered today, so a fest-scoped volunteer reads their fest-mates' shifts by design.
    // That is the legacy scope's existing behaviour and is deliberately NOT extended to event-role volunteers (see above).
    await assertSucceeds(getDoc(doc(as(legacyVolunteer), "shifts", "shLeg2")));
    await assertSucceeds(getDocs(query(shifts(as(legacyOther)), where("festId", "==", "fest1"), where("userId", "==", "leg1"))));
  });

  it("still cannot write shifts", async () => {
    await assertFails(updateDoc(doc(as(legacyVolunteer), "shifts", "shLeg"), { post: "arena2" }));
    await assertFails(deleteDoc(doc(as(legacyVolunteer), "shifts", "shLeg")));
  });
});

describe("who may roster a scorer", () => {
  const rostering = (createdBy: string) => ({ id: "new", festId: "fest1", userId: "scorerA", userName: "A", userEmail: "a@plansphere.test", post: "arena2", duty: "scoring", date: "2026-09-26", startTime: "00:00", endTime: "23:59", eventIds: [], cancelled: false, createdBy, createdAt: new Date(), updatedAt: new Date() });

  it("the Event Head may; a student, a legacy volunteer and another fest's head may not", async () => {
    await assertSucceeds(setDoc(doc(as(head), "shifts", "new"), rostering("head1")));
    await assertFails(setDoc(doc(as(student), "shifts", "new2"), rostering("stu1")));
    await assertFails(setDoc(doc(as(legacyVolunteer), "shifts", "new3"), rostering("leg1")));
    await assertFails(setDoc(doc(as(elsewhere), "shifts", "new4"), rostering("else1")));
  });

  it("lets the head list the whole fest roster", async () => {
    await assertSucceeds(getDocs(query(shifts(as(head)), where("festId", "==", "fest1"))));
  });
});

describe("the public scoreboard", () => {
  it("shows arenas and live scores to anyone, signed in or not, and lets no client change them", async () => {
    await assertSucceeds(getDoc(doc(anon(), "arenas", "arena1")));
    await assertSucceeds(getDoc(doc(anon(), "matches", "match1")));
    await assertSucceeds(getDocs(query(collection(anon(), "matches"), where("status", "==", "live"))));
    await assertSucceeds(getDocs(query(collection(anon(), "matches"), where("arenaId", "==", "arena1"))));
    await assertFails(updateDoc(doc(as(scorerA), "matches", "match1"), { "score.home": 9 }));
    await assertFails(updateDoc(doc(anon(), "matches", "match1"), { "score.home": 9 }));
    await assertFails(setDoc(doc(as(scorerA), "matchLog", "log1"), { matchId: "match1", type: "goal", side: "home" }));
  });
});
