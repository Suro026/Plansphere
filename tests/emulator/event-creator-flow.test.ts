import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";
import { POST as registerEvent } from "@/app/api/register-event/route";
import { POST as decide } from "@/app/api/admin/fests/[id]/verification/route";
import { PATCH as festAction } from "@/app/api/admin/fests/[id]/route";
import { GET as listMembers, POST as assignMember } from "@/app/api/admin/fests/[id]/members/route";
import { PATCH as updateMember } from "@/app/api/admin/fests/[id]/members/[uid]/route";
import { PATCH as updateEvent } from "@/app/api/admin/events/[id]/route";
import { GET as platform } from "@/app/api/admin/platform/route";
import { callRoute, freshToken, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * The corrected creator journey, end to end through the real handlers:
 *
 *   College Event Creator  ->  (platform approval)  ->  Event Super Admin  ->  admins / coordinators  ->  volunteers
 *
 * What these pin down: anyone, including existing staff, can apply with the account they have; nothing is granted until the
 * platform approves; approval only ever adds a fest-scoped `head` membership and never the platform's `super_admin`; existing
 * access and other events are untouched; an Event Super Admin can invite people before assigning competitions; the emails
 * around the application go out; and the platform boundary keeps event roles away from platform powers.
 */

let reviewer: TestUser; // platform super_admin
let legacyAdmin: TestUser; // admin of "other-fest" the pre-membership way
let gateVolunteer: TestUser; // volunteer at "other-fest"
let student: TestUser;
let creatorB: TestUser; // creates a second, unrelated event

const body = (name: string) => ({
  organizationName: "Test Institute of Technology",
  organizationType: "college" as const,
  contactEmail: "events@test-institute.edu",
  city: "Chennai",
  state: "Tamil Nadu",
  name,
  description: "A three-day tech and culture fest.",
  festType: "tech" as const,
  startDate: "2026-11-01",
  endDate: "2026-11-03",
  venue: "Main campus",
  expectedParticipants: 500,
  eventHead: { name: "Meena R. Kumar", designation: "Cultural Secretary", phone: "+919000000000" },
});

const profile = (u: TestUser, festIds: string[]) =>
  adminDb()
    .collection(COLLECTIONS.users)
    .doc(u.uid)
    .set({ id: u.uid, email: u.email, name: u.name, role: u.role, festIds, profileCompleted: true, mustChangePassword: false, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });

beforeAll(async () => {
  await resetAuth();
  reviewer = await mintUser({ role: "super_admin", name: "Platform Reviewer" });
  legacyAdmin = await mintUser({ role: "admin", festIds: ["other-fest"], name: "Legacy Admin" });
  gateVolunteer = await mintUser({ role: "volunteer", festIds: ["other-fest"], name: "Gate Volunteer" });
  student = await mintUser({ name: "Student Creator" });
  creatorB = await mintUser({ name: "Second Creator" });
});

beforeEach(async () => {
  await resetFirestore();
  await profile(reviewer, []);
  await profile(student, []);
  await profile(creatorB, []);
  await profile(legacyAdmin, ["other-fest"]);
  await profile(gateVolunteer, ["other-fest"]);
  await seedFest({ id: "other-fest", slug: "other-fest", name: "Other Fest" });
  await seedFest({ id: "third-fest", slug: "third-fest", name: "Third Fest" });
});

const apply = (user: TestUser, name: string) => callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: user.idToken, body: body(name) });
const decideAs = (user: TestUser, festId: string, payload: Record<string, unknown>) =>
  callRoute(decide, { method: "POST", path: `/api/admin/fests/${festId}/verification`, params: { id: festId }, token: user.idToken, body: payload });
const approve = (festId: string) => decideAs(reviewer, festId, { action: "approve" });
const patchFest = (token: string, festId: string, changes: Record<string, unknown>) =>
  callRoute(festAction, { method: "PATCH", path: `/api/admin/fests/${festId}`, params: { id: festId }, token, body: { action: "edit", changes } });
const members = (token: string, festId: string) => callRoute(listMembers, { path: `/api/admin/fests/${festId}/members`, params: { id: festId }, token });
const invite = (token: string, festId: string, payload: Record<string, unknown>) =>
  callRoute(assignMember, { method: "POST", path: `/api/admin/fests/${festId}/members`, params: { id: festId }, token, body: payload });
const claimsOf = async (u: TestUser) => (await adminAuth().getUser(u.uid)).customClaims ?? {};
const mailTo = async (to: string, template: string) =>
  (await adminDb().collection(COLLECTIONS.emailLog).where("to", "==", to).where("template", "==", template).get()).docs.map((d) => d.data());

describe("existing staff create their own event with the account they already have", () => {
  it("an admin of another fest becomes the Event Super Admin of the new event only; the old scope and everything else is unchanged", async () => {
    const created = await apply(legacyAdmin, "Admin's Own Fest");
    expect(created.status).toBe(201);
    const festId = created.body.fest.id as string;

    // Nothing is granted by applying.
    expect(await claimsOf(legacyAdmin)).toEqual({ role: "admin", festIds: ["other-fest"] });
    expect((await patchFest(legacyAdmin.idToken, festId, { name: "Early" })).status).toBe(403);

    expect((await approve(festId)).status).toBe(200);
    const token = await freshToken(legacyAdmin);
    const claims = await claimsOf(legacyAdmin);

    // Event-scoped: a head membership on THIS fest, the account's own role and legacy scope untouched, never super_admin.
    const member = (await adminDb().collection(COLLECTIONS.festMembers).where("userId", "==", legacyAdmin.uid).get()).docs.map((d) => d.data());
    expect(member).toHaveLength(1);
    expect(member[0]).toMatchObject({ festId, role: "head", status: "active" });
    expect(claims.festIds).toEqual(["other-fest"]);
    expect(claims.fm).toEqual([festId]);
    expect(claims.role).not.toBe("super_admin");
    expect(claims.br ?? claims.role).toBe("admin");
    expect((await adminDb().collection(COLLECTIONS.users).doc(legacyAdmin.uid).get()).data()?.role).toBe("admin");

    // They run the new event, still work the old one as before, and reach no third event.
    expect((await patchFest(token, festId, { name: "Admin's Own Fest 2026" })).status).toBe(200);
    expect((await patchFest(token, "other-fest", { name: "Other Fest, still mine" })).status).toBe(200);
    expect((await patchFest(token, "third-fest", { name: "Hijacked" })).status).toBe(403);
  });

  it("a volunteer becomes an Event Super Admin of the new event but is still only a volunteer at the old one", async () => {
    const festId = (await apply(gateVolunteer, "Volunteer's Own Fest")).body.fest.id as string;
    expect((await approve(festId)).status).toBe(200);
    const token = await freshToken(gateVolunteer);

    const claims = await claimsOf(gateVolunteer);
    expect(claims.br).toBe("volunteer");
    expect(claims.role).not.toBe("super_admin");
    expect((await adminDb().collection(COLLECTIONS.users).doc(gateVolunteer.uid).get()).data()?.role).toBe("volunteer");

    // New event: full event powers. Old event: still a scanner, not an admin.
    expect((await patchFest(token, festId, { name: "Volunteer's Own Fest 2026" })).status).toBe(200);
    expect((await members(token, festId)).status).toBe(200);
    expect((await patchFest(token, "other-fest", { name: "Promoted?" })).status).toBe(403);
    expect((await members(token, "other-fest")).status).toBe(403);
  });
});

describe("event isolation and privilege boundaries", () => {
  it("one college's Event Super Admin cannot read, change or staff another college's event, nor decide their own application", async () => {
    const festA = (await apply(student, "College A Fest")).body.fest.id as string;
    const festB = (await apply(creatorB, "College B Fest")).body.fest.id as string;
    await approve(festA);
    await approve(festB);
    const tokenA = await freshToken(student);

    expect((await patchFest(tokenA, festA, { name: "College A Fest 2026" })).status).toBe(200);
    expect((await patchFest(tokenA, festB, { name: "Hijacked" })).status).toBe(403);
    expect((await members(tokenA, festB)).status).toBe(403);
    expect((await invite(tokenA, festB, { email: `x-${Date.now()}@plansphere.test`, role: "coordinator", eventIds: [] })).status).toBe(403);

    // The platform's decision is the platform's: an event's own head cannot approve or reject anything.
    const another = (await apply(legacyAdmin, "Pending Fest")).body.fest.id as string;
    expect((await decideAs(student, another, { action: "approve" })).status).toBe(403);
    expect((await decideAs(student, festA, { action: "reject", reason: "no" })).status).toBe(403);
  });

  it("the platform boundary: an Event Super Admin is never platform staff, and an unregistered super admin loses platform power once it is enforced", async () => {
    const festId = (await apply(student, "Boundary Fest")).body.fest.id as string;
    await approve(festId);
    const head = await freshToken(student);

    expect((await adminDb().collection(COLLECTIONS.platformStaff).doc(student.uid).get()).exists).toBe(false);
    expect((await callRoute(platform, { path: "/api/admin/platform", token: head })).status).toBe(403);

    // Enforced boundary with the reviewer NOT registered: the role claim alone no longer opens platform routes...
    await adminDb().collection(COLLECTIONS.platformConfig).doc("boundary").set({ enforce: true, requireMfa: false });
    expect((await callRoute(platform, { path: "/api/admin/platform", token: reviewer.idToken })).status).toBe(403);
    // ...and registering the reviewer restores exactly that, nothing more.
    await adminDb().collection(COLLECTIONS.platformStaff).doc(reviewer.uid).set({ status: "active", email: reviewer.email });
    expect((await callRoute(platform, { path: "/api/admin/platform", token: reviewer.idToken })).status).toBe(200);
    // The event's head is still not the platform, registry or not.
    expect((await callRoute(platform, { path: "/api/admin/platform", token: head })).status).toBe(403);
  });

  it("registering an event never creates a platform role: not on the profile, not in the claims", async () => {
    const festId = (await apply(creatorB, "No Platform Role")).body.fest.id as string;
    await approve(festId);
    const claims = await claimsOf(creatorB);
    expect(claims.role).not.toBe("super_admin");
    expect(Object.values(claims)).not.toContain("super_admin");
    expect((await adminDb().collection(COLLECTIONS.users).doc(creatorB.uid).get()).data()?.role).toBe("student");
  });
});

describe("the Event Super Admin builds the team: invite now, assign competitions later", () => {
  // The people invited here already have accounts (an invitation to a new address creates one with a temporary password,
  // which must be changed before the API accepts it - covered by the staff tests). Existing accounts keep these tests about scope.
  it("can invite a coordinator before any competition exists; they reach nothing until assigned, then only what they were given", async () => {
    const festId = (await apply(student, "Team Fest")).body.fest.id as string;
    await approve(festId);
    await seedEvent({ id: "ev1", festId, slug: "ev1" });
    await seedEvent({ id: "ev2", festId, slug: "ev2" });
    const head = await freshToken(student);

    const coordinator = await mintUser({ name: "Invited Coordinator" });
    await profile(coordinator, []);
    const invited = await invite(head, festId, { email: coordinator.email, role: "coordinator", eventIds: [] });
    expect(invited.status).toBe(201);
    const stored = (await adminDb().collection(COLLECTIONS.festMembers).doc(`${festId}__${coordinator.uid}`).get()).data();
    expect(stored).toMatchObject({ role: "coordinator", eventIds: [], status: "active" });

    const edit = (token: string, eventId: string) => callRoute(updateEvent, { method: "PATCH", path: "/x", params: { id: eventId }, token, body: { description: "Edited" } });
    // Invited but unassigned: nothing to touch, on either competition.
    const token0 = await freshToken(coordinator);
    expect((await edit(token0, "ev1")).status).toBe(403);
    expect((await edit(token0, "ev2")).status).toBe(403);

    // Assign ev1 only.
    expect((await callRoute(updateMember, { method: "PATCH", path: "/x", params: { id: festId, uid: coordinator.uid }, token: head, body: { eventIds: ["ev1"] } })).status).toBe(200);
    const token1 = await freshToken(coordinator);
    expect((await edit(token1, "ev1")).status).toBe(200);
    expect((await edit(token1, "ev2")).status).toBe(403);
    // And never the people: a coordinator cannot invite anyone.
    const other = await mintUser({ name: "Would-be Volunteer" });
    expect((await invite(token1, festId, { email: other.email, role: "volunteer", duties: ["entry"], eventIds: ["ev1"] })).status).toBe(403);
  });

  it("an event admin cannot invite without naming a competition they work on; only the Event Super Admin can invite unassigned", async () => {
    const festId = (await apply(student, "Admin Scope Fest")).body.fest.id as string;
    await approve(festId);
    await seedEvent({ id: "ev1", festId, slug: "ev1" });
    const head = await freshToken(student);

    const eventAdmin = await mintUser({ name: "Event Admin" });
    await profile(eventAdmin, []);
    expect((await invite(head, festId, { email: eventAdmin.email, role: "admin", eventIds: ["ev1"] })).status).toBe(201);
    const adminToken = await freshToken(eventAdmin);

    const v1 = await mintUser({ name: "Volunteer One" });
    const v2 = await mintUser({ name: "Volunteer Two" });
    expect((await invite(adminToken, festId, { email: v1.email, role: "volunteer", duties: ["entry"], eventIds: [] })).status).toBe(403);
    expect((await invite(adminToken, festId, { email: v2.email, role: "volunteer", duties: ["entry"], eventIds: ["ev1"] })).status).toBe(201);
    // The Event Super Admin can leave a volunteer unassigned until later.
    const v3 = await mintUser({ name: "Volunteer Three" });
    expect((await invite(head, festId, { email: v3.email, role: "volunteer", duties: ["entry"], eventIds: [] })).status).toBe(201);
  });
});

describe("application emails", () => {
  it("confirms to the applicant, alerts the reviewers, and tells the applicant the decision", async () => {
    const created = await apply(student, "Mail Fest");
    const festId = created.body.fest.id as string;

    expect(await mailTo(student.email, "application_received")).toHaveLength(1);
    expect(await mailTo(reviewer.email, "application_review_request")).toHaveLength(1);
    // The reviewer is told an event is waiting, not who applied.
    const alert = (await adminDb().collection(COLLECTIONS.emailLog).where("template", "==", "application_review_request").get()).docs[0]!.data();
    expect(JSON.stringify(alert)).not.toContain(student.email);

    await approve(festId);
    const approved = await mailTo(student.email, "application_approved");
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({ festId, subjectType: "fest" });

    const second = (await apply(creatorB, "Rejected Fest")).body.fest.id as string;
    expect((await decideAs(reviewer, second, { action: "reject", reason: "Please add your college website." })).status).toBe(200);
    expect(await mailTo(creatorB.email, "application_rejected")).toHaveLength(1);
    expect(await mailTo(creatorB.email, "application_approved")).toHaveLength(0);
  });

  it("does not email a reviewer who is also the applicant, and a platform registration needs no review email", async () => {
    const own = await apply(reviewer, "Platform's Own Event");
    expect(own.status).toBe(201);
    expect(own.body.application.status).toBe("approved");
    expect(await mailTo(reviewer.email, "application_review_request")).toHaveLength(0);
    expect(await mailTo(reviewer.email, "application_received")).toHaveLength(0);
  });
});
