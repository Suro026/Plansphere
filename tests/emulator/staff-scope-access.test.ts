import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";
import { GET as myAccess } from "@/app/api/me/access/route";
import { GET as listFests } from "@/app/api/admin/fests/route";
import { GET as listStaff } from "@/app/api/admin/staff/route";
import { PATCH as festAction } from "@/app/api/admin/fests/[id]/route";
import { GET as listMembers } from "@/app/api/admin/fests/[id]/members/route";
import { PATCH as updateEvent } from "@/app/api/admin/events/[id]/route";
import { GET as platform } from "@/app/api/admin/platform/route";
import { callRoute, freshToken, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * Who gets into the staff side, and on what grounds.
 *
 * The rule under test: admin access comes from something explicitly assigned - a fest the account was given, or an event
 * role - and never from the word "admin" on a profile. An account whose role says admin or volunteer but that holds
 * neither is an ordinary account: the API refuses its staff calls (the browser shows it the Student section for the same
 * reason; see tests/components/staff-scope-ui.test.tsx). Every assigned account keeps exactly what it was assigned.
 */

let platformAdmin: TestUser;
let student: TestUser;
let unassignedAdmin: TestUser; // role admin, no fest, no membership
let unassignedVolunteer: TestUser;
let legacyAdmin: TestUser; // role admin, scoped to fest-a by the legacy festIds
let legacyOwner: TestUser; // owner of fest-a, legacy scope, no membership
let novaxHead: TestUser; // legacy owner AND head membership of "novax" (the production shape)
let memberOnlyHead: TestUser; // head by membership alone, no legacy scope

const edit = (token: string, festId: string) =>
  callRoute(festAction, { method: "PATCH", path: `/api/admin/fests/${festId}`, params: { id: festId }, token, body: { action: "edit", changes: { description: "Edited" } } });
const editEvent = (token: string, eventId: string) => callRoute(updateEvent, { method: "PATCH", path: "/x", params: { id: eventId }, token, body: { description: "Edited" } });
const members = (token: string, festId: string) => callRoute(listMembers, { path: `/api/admin/fests/${festId}/members`, params: { id: festId }, token });
const staffCalls = (token: string) => [
  callRoute(listFests, { path: "/api/admin/fests", token }),
  callRoute(listStaff, { path: "/api/admin/staff", token }),
  callRoute(platform, { path: "/api/admin/platform", token }),
];

const profile = (u: TestUser, over: Record<string, unknown> = {}) =>
  adminDb()
    .collection(COLLECTIONS.users)
    .doc(u.uid)
    .set({ id: u.uid, email: u.email, name: u.name, role: u.role, festIds: [], profileCompleted: true, mustChangePassword: false, emailVerified: true, createdAt: new Date(), updatedAt: new Date(), ...over });

const membership = (festId: string, u: TestUser, role: "head" | "admin" | "coordinator", eventIds: string[] = []) =>
  adminDb()
    .collection(COLLECTIONS.festMembers)
    .doc(`${festId}__${u.uid}`)
    .set({ id: `${festId}__${u.uid}`, festId, userId: u.uid, role, eventIds, duties: [], status: "active", createdBy: "test", createdAt: new Date(), updatedAt: new Date() });

beforeAll(async () => {
  await resetAuth();
  platformAdmin = await mintUser({ role: "super_admin", name: "Platform" });
  student = await mintUser({ name: "Plain Student" });
  unassignedAdmin = await mintUser({ role: "admin", festIds: [], name: "Unassigned Admin" });
  unassignedVolunteer = await mintUser({ role: "volunteer", festIds: [], name: "Unassigned Volunteer" });
  legacyAdmin = await mintUser({ role: "admin", festIds: ["fest-a"], name: "Legacy Admin" });
  legacyOwner = await mintUser({ role: "admin", festIds: ["fest-a"], name: "Legacy Owner" });
  novaxHead = await mintUser({ role: "admin", festIds: ["novax"], name: "Novax Head" });
  memberOnlyHead = await mintUser({ role: "student", name: "Member Only Head" });
});

beforeEach(async () => {
  await resetFirestore();
  for (const u of [platformAdmin, student, unassignedAdmin, unassignedVolunteer, legacyAdmin, legacyOwner, novaxHead, memberOnlyHead]) {
    await profile(u, { festIds: u === legacyAdmin || u === legacyOwner ? ["fest-a"] : u === novaxHead ? ["novax"] : [] });
  }
  await seedFest({ id: "fest-a", slug: "fest-a", name: "Fest A", ownerId: legacyOwner.uid });
  await seedFest({ id: "fest-b", slug: "fest-b", name: "Fest B", ownerId: "someone-else" });
  await seedFest({ id: "novax", slug: "novax", name: "NovaX", ownerId: novaxHead.uid });
  await seedEvent({ id: "nv-ev1", festId: "novax", slug: "nv-ev1" });
  await seedEvent({ id: "nv-ev2", festId: "novax", slug: "nv-ev2" });
  await seedEvent({ id: "b-ev1", festId: "fest-b", slug: "b-ev1" });
  await membership("novax", novaxHead, "head");
  await adminDb().collection(COLLECTIONS.users).doc(novaxHead.uid).set({ memberOf: ["novax"] }, { merge: true });
  await membership("fest-b", memberOnlyHead, "head");
  await adminDb().collection(COLLECTIONS.users).doc(memberOnlyHead.uid).set({ memberOf: ["fest-b"] }, { merge: true });
});

describe("an account with nothing assigned reaches nothing: a student and a volunteer are students, an admin keeps its role", () => {
  it("a student cannot call protected admin APIs", async () => {
    const token = await freshToken(student);
    for (const call of await Promise.all(staffCalls(token))) expect(call.status).toBe(403);
    expect((await edit(token, "fest-a")).status).toBe(403);
    expect((await members(token, "fest-a")).status).toBe(403);
    expect((await callRoute(myAccess, { path: "/api/me/access", token })).body).toMatchObject({ role: "student", memberships: [] });
  });

  it("an admin that was never given a fest keeps the role it was given - and can reach no fest, event, person or the platform", async () => {
    // The shape of the original `organizers (admin)` accounts, migrated with an empty scope. They were admins before event
    // roles existed and a release must not change what they are. What protects every fest is the scope, not the label.
    const token = await freshToken(unassignedAdmin);
    const [fests, staff, platformCall] = await Promise.all(staffCalls(token));
    expect(fests!.status).toBe(200);
    expect(fests!.body).toMatchObject({ fests: [] });
    expect(staff!.status).toBe(200);
    expect(staff!.body).toMatchObject({ staff: [] });
    expect(platformCall!.status).toBe(403); // the platform is the super admin's alone
    for (const festId of ["fest-a", "fest-b", "novax"]) {
      expect((await edit(token, festId)).status).toBe(403);
      expect((await members(token, festId)).status).toBe(403);
    }
    expect((await editEvent(token, "nv-ev1")).status).toBe(403);
    expect((await editEvent(token, "b-ev1")).status).toBe(403);
    expect((await callRoute(myAccess, { path: "/api/me/access", token })).body).toMatchObject({ role: "admin", memberships: [] });
  });

  it("the same for a volunteer who was never given a fest", async () => {
    const token = await freshToken(unassignedVolunteer);
    expect((await edit(token, "fest-a")).status).toBe(403);
    expect((await callRoute(myAccess, { path: "/api/me/access", token })).body.role).toBe("student");
  });

  it("scope comes from the profile document, not from a cached token: an old token that still lists a fest does not revive a removed assignment", async () => {
    const holder = await mintUser({ role: "admin", festIds: ["fest-a"], name: "Removed Admin" });
    await profile(holder, { festIds: [] }); // the assignment was removed after the token was minted; the token still says fest-a
    const claims = (await adminAuth().getUser(holder.uid)).customClaims;
    expect(claims?.festIds).toEqual(["fest-a"]);
    expect((await edit(await freshToken(holder), "fest-a")).status).toBe(403);
  });

  it("a profile that is missing, or a role nobody defined, is never a default admin", async () => {
    const ghost = await mintUser({ role: "admin", festIds: ["fest-a"], profile: false, name: "No Profile" });
    expect((await edit(await freshToken(ghost), "fest-a")).status).toBe(403);
    const odd = await mintUser({ role: "student", festIds: ["fest-a"], name: "Odd Role" });
    await profile(odd, { role: "owner", festIds: ["fest-a"] });
    expect((await edit(await freshToken(odd), "fest-a")).status).toBe(403);
  });
});

describe("an explicit assignment still opens exactly what it assigned", () => {
  it("an admin assigned to a fest runs that fest and nothing else", async () => {
    const token = await freshToken(legacyAdmin);
    expect((await edit(token, "fest-a")).status).toBe(200);
    expect((await edit(token, "fest-b")).status).toBe(403);
    expect((await edit(token, "novax")).status).toBe(403);
    expect((await callRoute(listFests, { path: "/api/admin/fests", token })).status).toBe(200);
    expect((await callRoute(platform, { path: "/api/admin/platform", token })).status).toBe(403);
  });

  it("a legacy fest owner keeps the access the legacy scheme gave them, including the people on the fest", async () => {
    const token = await freshToken(legacyOwner);
    expect((await edit(token, "fest-a")).status).toBe(200);
    expect((await members(token, "fest-a")).status).toBe(200);
    expect((await edit(token, "fest-b")).status).toBe(403);
  });

  it("one event's admin membership grants nothing on another event", async () => {
    const eventAdmin = await mintUser({ role: "student", name: "Event Admin" });
    await profile(eventAdmin);
    await membership("novax", eventAdmin, "admin", ["nv-ev1"]);
    await adminDb().collection(COLLECTIONS.users).doc(eventAdmin.uid).set({ memberOf: ["novax"] }, { merge: true });
    const token = await freshToken(eventAdmin);
    expect((await editEvent(token, "nv-ev1")).status).toBe(200);
    expect((await editEvent(token, "nv-ev2")).status).toBe(403); // same fest, not assigned
    expect((await editEvent(token, "b-ev1")).status).toBe(403); // another fest
    expect((await edit(token, "novax")).status).toBe(403); // fest-wide edits stay with the head
    expect((await edit(token, "fest-b")).status).toBe(403);
  });
});

describe("the NovaX Event Super Admin", () => {
  it("manages NovaX and its sub-events - by membership and by the legacy ownership it already had", async () => {
    const token = await freshToken(novaxHead);
    expect((await edit(token, "novax")).status).toBe(200);
    expect((await editEvent(token, "nv-ev1")).status).toBe(200);
    expect((await editEvent(token, "nv-ev2")).status).toBe(200);
    expect((await members(token, "novax")).status).toBe(200);
    const access = await callRoute(myAccess, { path: "/api/me/access", token });
    expect(access.body.memberships).toEqual([expect.objectContaining({ festId: "novax", role: "head" })]);
  });

  it("does not become the platform Super Admin, and reaches no other event", async () => {
    const token = await freshToken(novaxHead);
    expect((await callRoute(platform, { path: "/api/admin/platform", token })).status).toBe(403);
    // The staff list is the scoped one an assigned admin always had: their own fests' people, never the platform's.
    const staff = await callRoute(listStaff, { path: "/api/admin/staff", token });
    expect(staff.status).toBe(200);
    expect(JSON.stringify(staff.body)).not.toContain(platformAdmin.uid);
    expect((await edit(token, "fest-a")).status).toBe(403);
    expect((await edit(token, "fest-b")).status).toBe(403);
    expect((await editEvent(token, "b-ev1")).status).toBe(403);
    const claims = (await adminAuth().getUser(novaxHead.uid)).customClaims ?? {};
    expect(claims.role).not.toBe("super_admin");
    expect(((await adminDb().collection(COLLECTIONS.users).doc(novaxHead.uid).get()).data() ?? {}).role).toBe("admin");
    expect((await adminDb().collection("platformStaff").doc(novaxHead.uid).get()).exists).toBe(false);
  });

  it("holds one membership: a second assignment is refused instead of duplicated", async () => {
    const id = `novax__${novaxHead.uid}`;
    await expect(
      adminDb().collection(COLLECTIONS.festMembers).doc(id).create({ id, festId: "novax", userId: novaxHead.uid, role: "head", status: "active" }),
    ).rejects.toThrow();
    const all = await adminDb().collection(COLLECTIONS.festMembers).where("festId", "==", "novax").where("userId", "==", novaxHead.uid).get();
    expect(all.size).toBe(1);
  });

  it("a head by membership alone (no legacy scope) runs their own event and nobody else's", async () => {
    const token = await freshToken(memberOnlyHead);
    expect((await edit(token, "fest-b")).status).toBe(200);
    expect((await editEvent(token, "b-ev1")).status).toBe(200);
    expect((await edit(token, "novax")).status).toBe(403);
    expect((await editEvent(token, "nv-ev1")).status).toBe(403);
    expect((await callRoute(platform, { path: "/api/admin/platform", token })).status).toBe(403);
  });
});

describe("the platform is unaffected", () => {
  it("a super admin is not lowered by the scope rule, and still reaches every fest", async () => {
    const token = await freshToken(platformAdmin);
    for (const call of await Promise.all(staffCalls(token))) expect(call.status).toBe(200);
    expect((await edit(token, "novax")).status).toBe(200);
    expect((await edit(token, "fest-b")).status).toBe(200);
  });
});
