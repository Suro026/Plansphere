import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { POST as register } from "@/app/api/registrations/route";
import { POST as joinTeam } from "@/app/api/registrations/join/route";
import { POST as teamAction } from "@/app/api/registrations/[id]/team/route";
import { POST as cancel } from "@/app/api/registrations/[id]/cancel/route";
import { GET as walletPass } from "@/app/api/registrations/[id]/wallet/[platform]/route";
import { PATCH as festAction } from "@/app/api/admin/fests/[id]/route";
import { callRoute, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are asserted field by field */

/**
 * The student registration system end to end.
 *
 * Everything here goes through the real handlers against the emulator: the
 * profile remembering what was typed, a team assembling from draft to
 * confirmed, a waitlist promoting transactionally, and the duplicate checks
 * that stop one person holding two entries for one event.
 */

let owner: TestUser;
let leader: TestUser;
let mate: TestUser;
let other: TestUser;

const TEAM_FIELDS = {
  builtIn: { phone: "required", college: "required", city: "required", department: "hidden", year: "hidden" },
  custom: [{ key: "tshirt", label: "T-shirt size", type: "select", requirement: "required", options: ["S", "M", "L"] }],
};

const solo = (user: TestUser, answers: Record<string, string> = {}, eventId = "ev1") =>
  callRoute(register, {
    path: "/api/registrations",
    token: user.idToken,
    body: { eventId, members: [{ name: user.name, email: user.email }], answers },
  });

const team = (user: TestUser, mates: TestUser[], answers: Record<string, string> = {}, eventId = "ev1") =>
  callRoute(register, {
    path: "/api/registrations",
    token: user.idToken,
    body: {
      eventId,
      teamName: "Null Pointers",
      members: [{ name: user.name, email: user.email }, ...mates.map((m) => ({ name: m.name, email: m.email }))],
      answers,
    },
  });

const setFields = (fields: unknown) =>
  callRoute(festAction, {
    path: "/api/admin/fests/fest1",
    method: "PATCH",
    params: { id: "fest1" },
    token: owner.idToken,
    body: { action: "registrationFields", fields },
  });

const profileOf = async (user: TestUser) => (await adminDb().collection(COLLECTIONS.users).doc(user.uid).get()).data() ?? {};

const registrationOf = async (id: string) => (await adminDb().collection(COLLECTIONS.registrations).doc(id).get()).data() ?? {};

const eventOf = async (id = "ev1") => (await adminDb().collection(COLLECTIONS.events).doc(id).get()).data() ?? {};

beforeAll(async () => {
  await resetAuth();
  owner = await mintUser({ role: "super_admin", name: "Platform Owner" });
  leader = await mintUser({ name: "Team Leader" });
  mate = await mintUser({ name: "Team Mate" });
  other = await mintUser({ name: "Someone Else" });
});

beforeEach(async () => {
  await resetFirestore();
  for (const user of [owner, leader, mate, other]) {
    await adminDb()
      .collection(COLLECTIONS.users)
      .doc(user.uid)
      .set({
        id: user.uid,
        uid: user.uid,
        email: user.email,
        name: user.name,
        role: user.role,
        festIds: [],
        profileCompleted: true,
        mustChangePassword: false,
        emailVerified: true,
        disabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
  }
  await seedFest();
});

/* ───────────── profile memory ───────────── */

describe("profile memory", () => {
  beforeEach(async () => {
    await seedEvent({ eventType: "solo", teamSize: { min: 1, max: 1 }, capacity: 20 });
    await setFields({ builtIn: { phone: "required", college: "required", city: "required" }, custom: [] });
  });

  it("remembers what the student typed, for next time", async () => {
    const first = await solo(leader, { phone: "+919000000001", college: "SRM", city: "Chennai" });
    expect(first.status).toBe(201);

    const profile = await profileOf(leader);
    expect(profile).toMatchObject({ phone: "+919000000001", college: "SRM", city: "Chennai" });
  });

  it("fills the gaps on the next registration, so the same answers need not be sent", async () => {
    await solo(leader, { phone: "+919000000001", college: "SRM", city: "Chennai" });
    await seedEvent({ id: "ev2", slug: "quiz", title: "Quiz", eventType: "solo", teamSize: { min: 1, max: 1 }, capacity: 20 });

    // Second event, nothing supplied: the server fills from the profile
    // rather than refusing, which is the whole promise of the engine.
    const second = await solo(leader, {}, "ev2");
    expect(second.status).toBe(201);

    const saved = await registrationOf(second.body.registration.id);
    expect(saved.answers).toEqual({ phone: "+919000000001", college: "SRM", city: "Chennai" });
  });

  it("does not let one registration rewrite a profile the student already set", async () => {
    await adminDb().collection(COLLECTIONS.users).doc(leader.uid).set({ college: "VIT" }, { merge: true });

    const created = await solo(leader, { phone: "+919000000001", college: "SRM", city: "Chennai" });
    expect(created.status).toBe(201);

    // The answer is kept on the entry; the profile keeps what the student set.
    expect((await registrationOf(created.body.registration.id)).answers.college).toBe("SRM");
    expect((await profileOf(leader)).college).toBe("VIT");
  });

  it("still refuses when neither the form nor the profile can answer", async () => {
    const refused = await solo(leader, { phone: "+919000000001" });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("missing-answers");
  });
});

/* ───────────── validation ───────────── */

describe("server-side validation", () => {
  beforeEach(async () => {
    await seedEvent({ eventType: "solo", teamSize: { min: 1, max: 1 }, capacity: 20 });
    await setFields(TEAM_FIELDS);
  });

  const full = { phone: "+919000000001", college: "SRM", city: "Chennai", tshirt: "M" };

  it("checks phone shape, choices and required-ness whatever the client sent", async () => {
    expect((await solo(leader, { ...full, phone: "nope" })).status).toBe(422);
    expect((await solo(leader, { ...full, tshirt: "XXL" })).status).toBe(422);
    expect((await solo(leader, { ...full, city: "   " })).status).toBe(422);
    expect((await solo(leader, full)).status).toBe(201);
  });

  it("refuses after the deadline and when registration is closed", async () => {
    await seedEvent({ id: "ev3", slug: "late", title: "Late", eventType: "solo", teamSize: { min: 1, max: 1 }, capacity: 20, registrationDeadline: "2020-01-01" });
    const late = await solo(leader, full, "ev3");
    expect(late.status).toBe(422);

    await seedEvent({ id: "ev4", slug: "shut", title: "Shut", eventType: "solo", teamSize: { min: 1, max: 1 }, capacity: 20, registrationOpen: false });
    expect((await solo(leader, full, "ev4")).status).toBe(422);
  });

  it("refuses a duplicate entry for the same event", async () => {
    expect((await solo(leader, full)).status).toBe(201);
    const again = await solo(leader, full);
    expect(again.status).toBe(409);
    expect((await eventOf()).registeredCount).toBe(1);
  });
});

/* ───────────── teams ───────────── */

describe("team registration", () => {
  beforeEach(async () => {
    await seedEvent({ eventType: "team", teamSize: { min: 2, max: 4 }, capacity: 10 });
    await setFields({ builtIn: { phone: "required", college: "required" }, custom: [] });
  });

  const answers = { phone: "+919000000001", college: "SRM" };

  it("starts as a draft and holds its seats while it assembles", async () => {
    const created = await team(leader, [mate], answers);
    expect(created.status).toBe(201);
    expect(created.body.registration.status).toBe("draft");
    expect(created.body.registration.joinCode).toMatch(/^[0-9A-HJ-NP-TV-Z]{6}$/);

    // Both seats are held even though only the leader has accepted.
    expect((await eventOf()).registeredCount).toBe(2);
  });

  it("confirms the moment the minimum accepts, and returns to draft if it is lost", async () => {
    const created = await team(leader, [mate], answers);
    const id = created.body.registration.id as string;

    const accepted = await callRoute(teamAction, {
      path: `/api/registrations/${id}/team`,
      params: { id },
      token: mate.idToken,
      body: { action: "accept" },
    });
    expect(accepted.status).toBe(200);
    expect((await registrationOf(id)).status).toBe("confirmed");

    // The teammate changes their mind: the team is short again.
    const declined = await callRoute(teamAction, {
      path: `/api/registrations/${id}/team`,
      params: { id },
      token: mate.idToken,
      body: { action: "decline" },
    });
    expect(declined.status).toBe(200);
    expect((await registrationOf(id)).status).toBe("draft");
    expect((await eventOf()).registeredCount).toBe(1);
  });

  it("lets someone join with the code, which counts as accepting", async () => {
    const created = await team(leader, [], answers);
    const id = created.body.registration.id as string;
    const code = created.body.registration.joinCode as string;

    const joined = await callRoute(joinTeam, { path: "/api/registrations/join", token: mate.idToken, body: { code } });
    expect(joined.status).toBe(200);
    expect(joined.body.joined).toBe(true);

    const saved = await registrationOf(id);
    expect(saved.status).toBe("confirmed");
    expect(saved.members).toHaveLength(2);
    expect((saved.members as any[])[1]).toMatchObject({ email: mate.email, inviteStatus: "accepted", userId: mate.uid });
    expect((await eventOf()).registeredCount).toBe(2);
  });

  it("refuses a code that would put someone on two teams for one event", async () => {
    const first = await team(leader, [], answers);
    const second = await callRoute(register, {
      path: "/api/registrations",
      token: other.idToken,
      body: { eventId: "ev1", teamName: "Second Team", members: [{ name: other.name, email: other.email }], answers },
    });
    expect(second.status).toBe(201);

    const clash = await callRoute(joinTeam, {
      path: "/api/registrations/join",
      token: other.idToken,
      body: { code: first.body.registration.joinCode },
    });
    expect(clash.status).toBe(409);
  });

  it("refuses an unknown code and a full team", async () => {
    expect((await callRoute(joinTeam, { path: "/api/registrations/join", token: mate.idToken, body: { code: "ZZZZZZ" } })).status).toBe(404);

    await seedEvent({ id: "ev5", slug: "duo", title: "Duo", eventType: "team", teamSize: { min: 1, max: 1 }, capacity: 10 });
    const tiny = await callRoute(register, {
      path: "/api/registrations",
      token: leader.idToken,
      body: { eventId: "ev5", teamName: "Solo Team", members: [{ name: leader.name, email: leader.email }], answers },
    });
    const full = await callRoute(joinTeam, {
      path: "/api/registrations/join",
      token: mate.idToken,
      body: { code: tiny.body.registration.joinCode },
    });
    expect(full.status).toBe(422);
    expect(full.body.error).toContain("full");
  });

  it("gives the team one shared ticket code", async () => {
    const created = await team(leader, [mate], answers);
    const id = created.body.registration.id as string;
    await callRoute(teamAction, { path: `/api/registrations/${id}/team`, params: { id }, token: mate.idToken, body: { action: "accept" } });

    const saved = await registrationOf(id);
    // One document, one code, however many people are on it.
    expect(saved.ticketCode).toBe(created.body.registration.ticketCode);
    expect(saved.members).toHaveLength(2);

    const mine = await adminDb().collection(COLLECTIONS.registrations).where("eventId", "==", "ev1").get();
    expect(mine.size).toBe(1);
  });
});

/* ───────────── the waitlist ───────────── */

describe("waitlist", () => {
  beforeEach(async () => {
    await seedEvent({ eventType: "solo", teamSize: { min: 1, max: 1 }, capacity: 1, waitlistEnabled: true });
    await setFields({ builtIn: { phone: "required", college: "required" }, custom: [] });
  });

  const answers = { phone: "+919000000001", college: "SRM" };

  it("waitlists the overflow without consuming a seat, then promotes on a cancellation", async () => {
    const first = await solo(leader, answers);
    expect(first.body.registration.status).toBe("confirmed");

    const second = await solo(mate, answers);
    expect(second.body.registration.status).toBe("waitlisted");
    expect((await eventOf()).registeredCount).toBe(1);

    const id = first.body.registration.id as string;
    const cancelled = await callRoute(cancel, { path: `/api/registrations/${id}/cancel`, params: { id }, token: leader.idToken, body: {} });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.promoted).toBe(second.body.registration.id);

    expect((await registrationOf(second.body.registration.id)).status).toBe("confirmed");
    expect((await eventOf()).registeredCount).toBe(1);
  });

  it("promotes a short-handed team to draft rather than confirmed", async () => {
    await seedEvent({ id: "ev6", slug: "pairs", title: "Pairs", eventType: "team", teamSize: { min: 2, max: 2 }, capacity: 2, waitlistEnabled: true });

    const holding = await callRoute(register, {
      path: "/api/registrations",
      token: leader.idToken,
      body: { eventId: "ev6", teamName: "First", members: [{ name: leader.name, email: leader.email }, { name: mate.name, email: mate.email }], answers },
    });
    expect(holding.body.registration.status).toBe("draft");

    const waiting = await callRoute(register, {
      path: "/api/registrations",
      token: other.idToken,
      body: { eventId: "ev6", teamName: "Second", members: [{ name: other.name, email: other.email }], answers },
    });
    expect(waiting.body.registration.status).toBe("waitlisted");

    const id = holding.body.registration.id as string;
    await callRoute(cancel, { path: `/api/registrations/${id}/cancel`, params: { id }, token: leader.idToken, body: {} });

    // It now holds a seat, but one person is not a team of two.
    expect((await registrationOf(waiting.body.registration.id)).status).toBe("draft");
  });
});

/* ───────────── the pass ───────────── */

describe("the wallet endpoint", () => {
  beforeEach(async () => {
    await seedEvent({ eventType: "solo", teamSize: { min: 1, max: 1 }, capacity: 10 });
    await setFields({ builtIn: {}, custom: [] });
  });

  it("builds the pass and reports what signing still needs", async () => {
    const created = await solo(leader);
    const id = created.body.registration.id as string;

    const apple = await callRoute(walletPass, {
      path: `/api/registrations/${id}/wallet/apple`,
      method: "GET",
      params: { id, platform: "apple" },
      token: leader.idToken,
    });
    expect(apple.status).toBe(501);
    expect(apple.body.available).toBe(false);
    expect(apple.body.requires).toContain("certificate");
    expect(apple.body.pass).toMatchObject({
      serialNumber: created.body.registration.ticketCode,
      eventTitle: "Capture the Flag",
      festName: "Bits2Bytes",
    });
    expect(String(apple.body.pass.barcodeValue)).toContain(`/t/${created.body.registration.ticketCode}`);
  });

  it("is refused to someone who is not on the entry", async () => {
    const created = await solo(leader);
    const id = created.body.registration.id as string;

    const refused = await callRoute(walletPass, {
      path: `/api/registrations/${id}/wallet/google`,
      method: "GET",
      params: { id, platform: "google" },
      token: other.idToken,
    });
    expect(refused.status).toBe(403);
  });
});
