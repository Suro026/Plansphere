import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { membershipIdFor, type Duty, type FestRole } from "@/core/models/membership";
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";
import { syncMemberAccess } from "@/server/membership";
import { GET as listMembers, POST as assignMember } from "@/app/api/admin/fests/[id]/members/route";
import { DELETE as revokeMember, PATCH as updateMember } from "@/app/api/admin/fests/[id]/members/[uid]/route";
import { GET as myAccess } from "@/app/api/me/access/route";
import { PATCH as festAction } from "@/app/api/admin/fests/[id]/route";
import { DELETE as deleteEvent, PATCH as updateEvent } from "@/app/api/admin/events/[id]/route";
import { POST as manualEntry } from "@/app/api/admin/attendance/manual/route";
import { POST as announce } from "@/app/api/admin/fests/[id]/announcements/route";
import { GET as exportRegistrations } from "@/app/api/admin/registrations/export/route";
import { POST as createStaff } from "@/app/api/admin/staff/route";
import { GET as platform } from "@/app/api/admin/platform/route";
import { GET as platformAudit } from "@/app/api/admin/platform/audit/route";
import { GET as reviewQueue } from "@/app/api/admin/verifications/route";
import { POST as decide } from "@/app/api/admin/fests/[id]/verification/route";
import { callRoute, freshToken, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * Event-level roles, through the real handlers against the Firestore and Auth emulators.
 *
 * What these pin down: the Event Head runs their own main event and no other; an admin or coordinator works only the
 * competitions they were given; nobody grants themselves anything or creates a second head; taking a role away works on
 * the next request; an event role never touches the platform's authority; and handing an event over leaves exactly one head.
 */

let head: TestUser;
let eventAdmin: TestUser; // admin of ev1
let secondAdmin: TestUser; // admin of ev2
let coordinator: TestUser; // coordinator of ev1
let gateVolunteer: TestUser; // volunteer of ev1, entry duty
let outsider: TestUser; // plain student
let otherHead: TestUser; // head of fest2
let platformAdmin: TestUser; // super_admin
let legacyAdmin: TestUser; // pre-membership admin of fest1, not its owner
let successor: TestUser; // legacy admin account that a transfer will make head

const profile = (u: TestUser, role: string, festIds: string[] = []) =>
  adminDb().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, name: u.name, role, festIds, profileCompleted: true, mustChangePassword: false, createdAt: new Date(), updatedAt: new Date() });

const grant = async (user: TestUser, role: FestRole, eventIds: string[], duties: Duty[] = [], festId = "fest1", status = "active") => {
  const id = membershipIdFor(festId, user.uid);
  await adminDb().collection(COLLECTIONS.festMembers).doc(id).set({ id, festId, userId: user.uid, role, eventIds, duties, status, createdBy: "seed", createdAt: new Date(), updatedAt: new Date() });
  await syncMemberAccess(user.uid);
};

beforeAll(async () => {
  await resetAuth();
  head = await mintUser({ name: "Event Head" });
  eventAdmin = await mintUser({ name: "Event One Admin" });
  secondAdmin = await mintUser({ name: "Event Two Admin" });
  coordinator = await mintUser({ name: "Event One Coordinator" });
  gateVolunteer = await mintUser({ name: "Gate Volunteer" });
  outsider = await mintUser({ name: "Outsider" });
  otherHead = await mintUser({ name: "Other Event Head" });
  platformAdmin = await mintUser({ role: "super_admin", name: "Platform Team" });
  legacyAdmin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Legacy Admin" });
  successor = await mintUser({ role: "admin", festIds: [], name: "Successor" });
});

beforeEach(async () => {
  await resetFirestore();
  await seedFest({ ownerId: head.uid, verification: { status: "approved", submittedAt: new Date(), basis: "review" } });
  await seedFest({ id: "fest2", slug: "other", name: "Other Fest", ownerId: otherHead.uid });
  await seedEvent();
  await seedEvent({ id: "ev2", slug: "robo", title: "Robotics" });
  await seedEvent({ id: "ev3", festId: "fest2", slug: "chess", title: "Chess" });
  for (const u of [head, eventAdmin, secondAdmin, coordinator, gateVolunteer, outsider, otherHead, successor]) await profile(u, u === successor ? "admin" : "student");
  await profile(platformAdmin, "super_admin");
  await profile(legacyAdmin, "admin", ["fest1"]);
  await grant(head, "head", []);
  await grant(otherHead, "head", [], [], "fest2");
  await grant(eventAdmin, "admin", ["ev1"]);
  await grant(secondAdmin, "admin", ["ev2"]);
  await grant(coordinator, "coordinator", ["ev1"]);
  await grant(gateVolunteer, "volunteer", ["ev1"], ["entry"]);
});

const members = (user: TestUser | null, festId = "fest1") => callRoute(listMembers, { path: `/api/admin/fests/${festId}/members`, params: { id: festId }, ...(user ? { token: user.idToken } : {}) });
const assign = (user: TestUser | null, body: Record<string, unknown>, festId = "fest1") =>
  callRoute(assignMember, { method: "POST", path: `/api/admin/fests/${festId}/members`, params: { id: festId }, ...(user ? { token: user.idToken } : {}), body });
const patchMember = (user: TestUser, uid: string, body: Record<string, unknown>, festId = "fest1") =>
  callRoute(updateMember, { method: "PATCH", path: `/x`, params: { id: festId, uid }, token: user.idToken, body });
const removeMember = (user: TestUser, uid: string, festId = "fest1") => callRoute(revokeMember, { method: "DELETE", path: `/x`, params: { id: festId, uid }, token: user.idToken });
const membership = async (user: TestUser, festId = "fest1") => (await adminDb().collection(COLLECTIONS.festMembers).doc(membershipIdFor(festId, user.uid)).get()).data();
const claimsOf = async (user: TestUser) => (await adminAuth().getUser(user.uid)).customClaims ?? {};
const emailOf = (n: string) => `${n}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@plansphere.test`;

/* ───────────── what the Event Head can do ───────────── */

describe("the Event Head assigns the people who work on their event", () => {
  it("gives an existing account an admin, coordinator or volunteer role, and never more than the role says", async () => {
    for (const [role, extra] of [["admin", {}], ["coordinator", {}], ["volunteer", { duties: ["entry", "meal"] }]] as const) {
      const person = await mintUser({ name: `New ${role}` });
      await profile(person, "student");
      const res = await assign(head, { email: person.email, role, eventIds: ["ev1"], ...extra });
      expect(res.status, role).toBe(201);
      expect(await membership(person)).toMatchObject({ festId: "fest1", role, status: "active", eventIds: ["ev1"], createdBy: head.uid });

      // Their own account is untouched; the claims carry the event role without becoming the platform's.
      const profileDoc = (await adminDb().collection(COLLECTIONS.users).doc(person.uid).get()).data()!;
      expect(profileDoc).toMatchObject({ role: "student", festIds: [], memberOf: ["fest1"] });
      const claims = await claimsOf(person);
      expect(claims.fm).toEqual(["fest1"]);
      expect(claims.br).toBe("student");
      expect(claims.role).not.toBe("super_admin");
    }
  });

  it("creates the account, mails the sign-in and forces a new password, when the person has none", async () => {
    const email = emailOf("newcomer");
    const res = await assign(head, { email, name: "Newcomer", role: "volunteer", eventIds: ["ev1"], duties: ["meal"] });
    expect(res.status).toBe(201);
    expect(res.body.invite.temporaryPassword).toEqual(expect.any(String));
    const created = await adminAuth().getUserByEmail(email);
    const doc = (await adminDb().collection(COLLECTIONS.users).doc(created.uid).get()).data()!;
    expect(doc).toMatchObject({ role: "student", mustChangePassword: true, memberOf: ["fest1"] });
    expect((await adminAuth().getUser(created.uid)).customClaims).toMatchObject({ mustChangePassword: true, fm: ["fest1"] });
  });

  it("refuses to make a second Event Head, however it is asked", async () => {
    const person = await mintUser({ name: "Would Be Head" });
    await profile(person, "student");
    expect((await assign(head, { email: person.email, role: "head", eventIds: ["ev1"] })).status).toBe(400);
    expect((await assign(platformAdmin, { email: person.email, role: "head", eventIds: ["ev1"] })).status).toBe(400);
    expect((await patchMember(head, eventAdmin.uid, { role: "head" })).status).toBe(400);
    const heads = (await adminDb().collection(COLLECTIONS.festMembers).where("festId", "==", "fest1").where("role", "==", "head").get()).docs;
    expect(heads).toHaveLength(1);
    expect(heads[0]!.data().userId).toBe(head.uid);
  });

  it("insists on a competition of this event, and a duty for a volunteer", async () => {
    const person = await mintUser({ name: "Strict Checks" });
    await profile(person, "student");
    expect((await assign(head, { email: person.email, role: "admin", eventIds: [] })).status).toBe(400);
    expect((await assign(head, { email: person.email, role: "volunteer", eventIds: ["ev1"], duties: [] })).status).toBe(400);
    expect((await assign(head, { email: person.email, role: "admin", eventIds: ["ev3"] })).status).toBe(422); // another main event's competition
    expect((await assign(head, { email: person.email, role: "admin", eventIds: ["no-such-event"] })).status).toBe(422);
    expect(await membership(person)).toBeUndefined();
  });

  it("refuses a second role for someone who has one, then allows it again after the first is revoked", async () => {
    expect((await assign(head, { email: eventAdmin.email, role: "coordinator", eventIds: ["ev2"] })).status).toBe(409);
    expect((await removeMember(head, eventAdmin.uid)).status).toBe(200);
    expect((await assign(head, { email: eventAdmin.email, role: "coordinator", eventIds: ["ev2"] })).status).toBe(201);
    expect(await membership(eventAdmin)).toMatchObject({ role: "coordinator", eventIds: ["ev2"], status: "active" });
  });

  it("refuses to assign the Event Head themselves, a platform account, or a disabled one", async () => {
    expect((await assign(head, { email: head.email, role: "admin", eventIds: ["ev1"] })).status).toBe(403);
    expect((await assign(head, { email: platformAdmin.email, role: "admin", eventIds: ["ev1"] })).status).toBe(409);
    const disabled = await mintUser({ name: "Disabled Person" });
    await profile(disabled, "student");
    await adminAuth().updateUser(disabled.uid, { disabled: true });
    expect((await assign(head, { email: disabled.email, role: "volunteer", eventIds: ["ev1"], duties: ["entry"] })).status).toBe(409);
  });

  it("refuses someone who is already staff here under the older scheme, rather than quietly narrowing them", async () => {
    expect((await assign(head, { email: legacyAdmin.email, role: "volunteer", eventIds: ["ev1"], duties: ["entry"] })).status).toBe(409);
  });

  it("changes, suspends, reinstates and revokes, each taking effect on the person's very next request", async () => {
    const eventPatch = (user: TestUser, eventId: string) => callRoute(updateEvent, { method: "PATCH", path: `/x/${eventId}`, params: { id: eventId }, token: user.idToken, body: { description: "Edited" } });

    expect((await eventPatch(eventAdmin, "ev1")).status).toBe(200);
    expect((await eventPatch(eventAdmin, "ev2")).status).toBe(403);

    // Give them a second competition.
    expect((await patchMember(head, eventAdmin.uid, { eventIds: ["ev1", "ev2"] })).status).toBe(200);
    expect((await eventPatch(eventAdmin, "ev2")).status).toBe(200);

    // Suspend: stopped at once with the very same token; reinstate: back.
    expect((await patchMember(head, eventAdmin.uid, { status: "suspended" })).status).toBe(200);
    expect((await eventPatch(eventAdmin, "ev1")).status).toBe(403);
    expect((await patchMember(head, eventAdmin.uid, { status: "active" })).status).toBe(200);
    expect((await eventPatch(eventAdmin, "ev1")).status).toBe(200);

    // Revoke: the end of it. The membership is no longer in their claims either.
    expect((await removeMember(head, eventAdmin.uid)).status).toBe(200);
    expect((await eventPatch(eventAdmin, "ev1")).status).toBe(403);
    expect((await claimsOf(eventAdmin)).fm).toBeUndefined();
    expect((await adminDb().collection(COLLECTIONS.users).doc(eventAdmin.uid).get()).data()?.memberOf).toEqual([]);
    expect((await patchMember(head, eventAdmin.uid, { status: "active" })).status).toBe(409);
  });
});

/* ───────────── what an admin can and cannot hand out ───────────── */

describe("an admin can only bring volunteers onto the competitions they run", () => {
  it("assigns a volunteer to their own competition", async () => {
    const person = await mintUser({ name: "Admin's Volunteer" });
    await profile(person, "student");
    const res = await assign(eventAdmin, { email: person.email, role: "volunteer", eventIds: ["ev1"], duties: ["entry"] });
    expect(res.status).toBe(201);
    expect(await membership(person)).toMatchObject({ role: "volunteer", eventIds: ["ev1"], createdBy: eventAdmin.uid });
  });

  it("refuses an admin or coordinator role, a competition they are not assigned, and a competition outside the event", async () => {
    const person = await mintUser({ name: "Overreach Target" });
    await profile(person, "student");
    expect((await assign(eventAdmin, { email: person.email, role: "admin", eventIds: ["ev1"] })).status).toBe(403);
    expect((await assign(eventAdmin, { email: person.email, role: "coordinator", eventIds: ["ev1"] })).status).toBe(403);
    expect((await assign(eventAdmin, { email: person.email, role: "volunteer", eventIds: ["ev2"], duties: ["entry"] })).status).toBe(403);
    expect((await assign(eventAdmin, { email: person.email, role: "volunteer", eventIds: ["ev1", "ev2"], duties: ["entry"] })).status).toBe(403);
    // Another main event's competition is not one they are assigned to either (the head gets the 422, for a competition that is not part of the event).
    expect((await assign(eventAdmin, { email: person.email, role: "volunteer", eventIds: ["ev3"], duties: ["entry"] })).status).toBe(403);
    expect(await membership(person)).toBeUndefined();
  });

  it("cannot assign themselves anything, or change their own role, or revoke themselves", async () => {
    expect((await assign(eventAdmin, { email: eventAdmin.email, role: "volunteer", eventIds: ["ev1"], duties: ["entry"] })).status).toBe(403);
    expect((await patchMember(eventAdmin, eventAdmin.uid, { eventIds: ["ev1", "ev2"] })).status).toBe(403);
    expect((await patchMember(eventAdmin, eventAdmin.uid, { role: "coordinator" })).status).toBe(403);
    expect((await removeMember(eventAdmin, eventAdmin.uid)).status).toBe(403);
    expect(await membership(eventAdmin)).toMatchObject({ role: "admin", eventIds: ["ev1"] });
  });

  it("cannot touch another admin, a coordinator, or the Event Head", async () => {
    for (const target of [secondAdmin, coordinator, head]) {
      expect((await patchMember(eventAdmin, target.uid, { status: "suspended" })).status, target.name).toBe(403);
      expect((await removeMember(eventAdmin, target.uid)).status, target.name).toBe(403);
    }
    expect(await membership(secondAdmin)).toMatchObject({ status: "active" });
    expect(await membership(head)).toMatchObject({ role: "head", status: "active" });
  });

  it("manages only the volunteers on their own competitions, and sees only those", async () => {
    const mine = await mintUser({ name: "Volunteer On Ev1" });
    const theirs = await mintUser({ name: "Volunteer On Ev2" });
    for (const p of [mine, theirs]) await profile(p, "student");
    await grant(mine, "volunteer", ["ev1"], ["meal"]);
    await grant(theirs, "volunteer", ["ev2"], ["meal"]);

    const list = await members(eventAdmin);
    expect(list.status).toBe(200);
    const ids = (list.body.members as Array<{ userId: string; role: string }>).map((m) => m.userId);
    expect(ids).toContain(mine.uid);
    expect(ids).toContain(gateVolunteer.uid);
    expect(ids).not.toContain(theirs.uid);
    expect(ids).not.toContain(head.uid);
    expect((list.body.members as Array<{ role: string }>).every((m) => m.role === "volunteer")).toBe(true);

    expect((await patchMember(eventAdmin, mine.uid, { duties: ["meal", "entry"] })).status).toBe(200);
    expect((await patchMember(eventAdmin, theirs.uid, { duties: ["entry"] })).status).toBe(403);
    expect((await removeMember(eventAdmin, theirs.uid)).status).toBe(403);
    expect((await removeMember(eventAdmin, mine.uid)).status).toBe(200);
    // They cannot widen a volunteer past their own competitions either.
    expect((await patchMember(eventAdmin, gateVolunteer.uid, { eventIds: ["ev1", "ev2"] })).status).toBe(403);
  });

  it("is refused outright by a coordinator, a volunteer, a student and an anonymous caller", async () => {
    for (const who of [coordinator, gateVolunteer, outsider]) {
      expect((await members(who)).status, who.name).toBe(403);
      expect((await assign(who, { email: outsider.email, role: "volunteer", eventIds: ["ev1"], duties: ["entry"] })).status, who.name).toBe(403);
    }
    expect((await members(null)).status).toBe(401);
    expect((await assign(null, { email: outsider.email, role: "volunteer", eventIds: ["ev1"], duties: ["entry"] })).status).toBe(401);
  });

  it("lets a pre-membership admin who is not the owner bring in volunteers only", async () => {
    const person = await mintUser({ name: "Legacy Admin's Volunteer" });
    await profile(person, "student");
    expect((await assign(legacyAdmin, { email: person.email, role: "volunteer", eventIds: ["ev1"], duties: ["entry"] })).status).toBe(201);
    expect((await assign(legacyAdmin, { email: person.email, role: "admin", eventIds: ["ev1"] })).status).toBe(403);
    const another = await mintUser({ name: "Another Target" });
    await profile(another, "student");
    expect((await assign(legacyAdmin, { email: another.email, role: "admin", eventIds: ["ev1"] })).status).toBe(403);
  });
});

/* ───────────── one main event never reaches another ───────────── */

describe("a role on one main event does not reach another", () => {
  it("keeps the head of one event out of the other's people, settings and competitions", async () => {
    expect((await members(otherHead, "fest1")).status).toBe(403);
    expect((await assign(otherHead, { email: outsider.email, role: "volunteer", eventIds: ["ev1"], duties: ["entry"] }, "fest1")).status).toBe(403);
    expect((await callRoute(festAction, { method: "PATCH", path: "/x", params: { id: "fest1" }, token: otherHead.idToken, body: { action: "edit", changes: { name: "Hijacked" } } })).status).toBe(403);
    expect((await callRoute(updateEvent, { method: "PATCH", path: "/x", params: { id: "ev1" }, token: otherHead.idToken, body: { description: "Hijacked" } })).status).toBe(403);
    expect((await patchMember(otherHead, eventAdmin.uid, { status: "suspended" }, "fest1")).status).toBe(403);
    expect((await removeMember(otherHead, eventAdmin.uid, "fest1")).status).toBe(403);
    // And the reverse.
    expect((await members(head, "fest2")).status).toBe(403);
    expect((await callRoute(festAction, { method: "PATCH", path: "/x", params: { id: "fest2" }, token: head.idToken, body: { action: "edit", changes: { name: "Hijacked" } } })).status).toBe(403);
  });

  it("does not let a head who is a plain volunteer elsewhere act as an admin there", async () => {
    // The Event Head of fest1 is also a legacy volunteer of fest2.
    await profile(head, "volunteer", ["fest2"]);
    await syncMemberAccess(head.uid);
    const claims = await claimsOf(head);
    expect(claims.br).toBe("volunteer");
    expect(claims.role).toBe("admin"); // raised for the app's admin area, nothing more

    // A fresh sign-in, as a real person would have: the token carries the raised role. (The stale token the test started with
    // would hide a leak, because the API trusts the weaker of the token and the profile.)
    const token = await freshToken(head);
    const forFest2 = (path: string, body: Record<string, unknown>) => callRoute(festAction, { method: "PATCH", path, params: { id: "fest2" }, token, body });
    expect((await forFest2("/x", { action: "edit", changes: { name: "Not Theirs" } })).status).toBe(403);
    expect((await callRoute(listMembers, { path: "/x", params: { id: "fest2" }, token })).status).toBe(403);
    expect((await callRoute(createStaff, { method: "POST", path: "/api/admin/staff", token, body: { name: "Helper", email: emailOf("helper"), role: "volunteer", festIds: ["fest2"] } })).status).toBe(403);
    // Still the head here.
    expect((await callRoute(festAction, { method: "PATCH", path: "/x", params: { id: "fest1" }, token, body: { action: "edit", changes: { name: "Still Theirs" } } })).status).toBe(200);
  });

  it("confines an admin to their competitions: the neighbouring one, and everything fest-wide, is refused", async () => {
    const edit = (user: TestUser, eventId: string) => callRoute(updateEvent, { method: "PATCH", path: "/x", params: { id: eventId }, token: user.idToken, body: { description: "Edited" } });
    expect((await edit(eventAdmin, "ev1")).status).toBe(200);
    expect((await edit(eventAdmin, "ev2")).status).toBe(403);
    expect((await edit(secondAdmin, "ev2")).status).toBe(200);
    expect((await edit(secondAdmin, "ev1")).status).toBe(403);
    expect((await edit(eventAdmin, "ev3")).status).toBe(403);

    // A role they do not have: deleting a competition and editing the fest are the head's.
    expect((await callRoute(deleteEvent, { method: "DELETE", path: "/x", params: { id: "ev1" }, token: eventAdmin.idToken })).status).toBe(403);
    expect((await callRoute(festAction, { method: "PATCH", path: "/x", params: { id: "fest1" }, token: eventAdmin.idToken, body: { action: "edit", changes: { name: "Hijacked" } } })).status).toBe(403);
    expect((await callRoute(announce, { method: "POST", path: "/x", params: { id: "fest1" }, token: eventAdmin.idToken, body: { title: "Hi", body: "All" } })).status).toBe(403);
    // A whole-fest export is the head's; one competition's is the assigned admin's.
    expect((await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest1&format=csv", token: eventAdmin.idToken, raw: true })).status).toBe(403);
    expect((await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest1&eventId=ev2&format=csv", token: eventAdmin.idToken, raw: true })).status).toBe(403);
    expect((await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest1&eventId=ev1&format=csv", token: eventAdmin.idToken, raw: true })).status).toBe(200);
  });

  it("limits a coordinator to details, results and attendance of their own competition", async () => {
    const edit = (eventId: string) => callRoute(updateEvent, { method: "PATCH", path: "/x", params: { id: eventId }, token: coordinator.idToken, body: { description: "Edited" } });
    expect((await edit("ev1")).status).toBe(200);
    expect((await edit("ev2")).status).toBe(403);
    expect((await callRoute(deleteEvent, { method: "DELETE", path: "/x", params: { id: "ev1" }, token: coordinator.idToken })).status).toBe(403);
    expect((await members(coordinator)).status).toBe(403);
    expect((await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest1&eventId=ev2&format=csv", token: coordinator.idToken, raw: true })).status).toBe(403);
  });

  it("refuses manual attendance on a competition the admin is not assigned to, using a ticket for it", async () => {
    const reg = (id: string, eventId: string, ticketCode: string) =>
      adminDb().collection(COLLECTIONS.registrations).doc(id).set({ id, eventId, festId: "fest1", userId: outsider.uid, type: "solo", seats: 1, ticketCode, status: "confirmed", members: [], memberEmails: [], eventTitle: "T", userName: "S", userEmail: outsider.email, createdAt: new Date(), updatedAt: new Date() });
    await reg("r1", "ev1", "PS-AAAAAAAAA1");
    await reg("r2", "ev2", "PS-AAAAAAAAA2");
    expect((await callRoute(manualEntry, { path: "/api/admin/attendance/manual", token: eventAdmin.idToken, body: { ticketCode: "PS-AAAAAAAAA2", eventId: "ev2" } })).status).toBe(403);
    expect((await callRoute(manualEntry, { path: "/api/admin/attendance/manual", token: eventAdmin.idToken, body: { ticketCode: "PS-AAAAAAAAA1", eventId: "ev1" } })).body.result).toBe("ok");
    expect((await adminDb().collection(COLLECTIONS.attendance).get()).size).toBe(1);
  });

  it("gives an event role no way to mint a staff account through the older staff route", async () => {
    for (const who of [head, eventAdmin, coordinator, gateVolunteer]) {
      const res = await callRoute(createStaff, { method: "POST", path: "/api/admin/staff", token: who.idToken, body: { name: "Elevated", email: emailOf("elevated"), role: "admin", festIds: ["fest1"] } });
      expect(res.status, who.name).toBe(403);
    }
  });
});

/* ───────────── the platform stays separate ───────────── */

describe("event roles never reach the platform's authority", () => {
  it("refuses every platform route to every event role, the Event Head included", async () => {
    for (const who of [head, otherHead, eventAdmin, coordinator, gateVolunteer]) {
      expect((await callRoute(platform, { path: "/api/admin/platform", token: who.idToken })).status, `${who.name} platform`).toBe(403);
      expect((await callRoute(platformAudit, { path: "/api/admin/platform/audit", token: who.idToken })).status, `${who.name} audit`).toBe(403);
      expect((await callRoute(reviewQueue, { path: "/api/admin/verifications", token: who.idToken })).status, `${who.name} queue`).toBe(403);
      expect((await callRoute(decide, { method: "POST", path: "/x", params: { id: "fest1" }, token: who.idToken, body: { action: "approve" } })).status, `${who.name} approve`).toBe(403);
    }
  });

  it("never writes the platform's role into anyone's claims or profile, whatever event roles they hold", async () => {
    for (const who of [head, otherHead, eventAdmin, secondAdmin, coordinator, gateVolunteer]) {
      const claims = await claimsOf(who);
      expect(claims.role, `${who.name} claim role`).not.toBe("super_admin");
      expect(claims.br, `${who.name} base role`).not.toBe("super_admin");
      const doc = (await adminDb().collection(COLLECTIONS.users).doc(who.uid).get()).data()!;
      expect(doc.role, `${who.name} profile role`).not.toBe("super_admin");
    }
    // The platform account is the only one, and no membership was needed for it.
    expect((await claimsOf(platformAdmin)).role).toBe("super_admin");
    expect((await claimsOf(platformAdmin)).fm).toBeUndefined();
  });

  it("describes a caller's own event roles back to them, and no one else's", async () => {
    const res = await callRoute(myAccess, { path: "/api/me/access", token: eventAdmin.idToken });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("student");
    expect(res.body.memberships).toEqual([{ festId: "fest1", role: "admin", eventIds: ["ev1"], duties: [] }]);
    expect((await callRoute(myAccess, { path: "/api/me/access", token: outsider.idToken })).body.memberships).toEqual([]);
    expect((await callRoute(myAccess, { path: "/api/me/access" })).status).toBe(401);
  });
});

/* ───────────── handing an event over ───────────── */

describe("handing an event to a new Event Head leaves exactly one", () => {
  const transfer = (user: TestUser, ownerId: string) => callRoute(festAction, { method: "PATCH", path: "/x", params: { id: "fest1" }, token: user.idToken, body: { action: "transfer", ownerId } });
  const activeHeads = async () => (await adminDb().collection(COLLECTIONS.festMembers).where("festId", "==", "fest1").where("role", "==", "head").where("status", "==", "active").get()).docs.map((d) => d.data().userId);

  it("moves the head role in one step: the old head is out at once, the new one is in", async () => {
    expect(await activeHeads()).toEqual([head.uid]);
    const res = await transfer(platformAdmin, successor.uid);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await activeHeads()).toEqual([successor.uid]);
    expect(await membership(head)).toMatchObject({ role: "head", status: "revoked", revokedBy: platformAdmin.uid });
    expect(await membership(successor)).toMatchObject({ role: "head", status: "active" });
    expect((await adminDb().collection(COLLECTIONS.fests).doc("fest1").get()).data()?.ownerId).toBe(successor.uid);

    // The former head's very next request is refused; the new head's works.
    const rename = (user: TestUser, name: string) => callRoute(festAction, { method: "PATCH", path: "/x", params: { id: "fest1" }, token: user.idToken, body: { action: "edit", changes: { name } } });
    expect((await rename(head, "Old Head Edit")).status).toBe(403);
    expect((await rename(successor, "New Head Edit")).status).toBe(200);
    // The old head's other roles survive: nothing else about their account changed.
    expect((await adminDb().collection(COLLECTIONS.users).doc(head.uid).get()).data()).toMatchObject({ role: "student", memberOf: [] });
  });

  it("is the platform's to do: the head cannot hand their own event over, nor can anyone with an event role", async () => {
    for (const who of [head, eventAdmin, coordinator]) expect((await transfer(who, successor.uid)).status, who.name).toBe(403);
    expect(await activeHeads()).toEqual([head.uid]);
  });

  it("replaces a lesser role the new head already held on the event", async () => {
    await grant(successor, "volunteer", ["ev1"], ["entry"]);
    expect((await transfer(platformAdmin, successor.uid)).status).toBe(200);
    expect(await membership(successor)).toMatchObject({ role: "head", status: "active", eventIds: [] });
    expect(await activeHeads()).toEqual([successor.uid]);
  });

  it("never gives the platform account a membership when the event is handed to it", async () => {
    const res = await transfer(platformAdmin, platformAdmin.uid);
    expect(res.status).toBe(200);
    expect(await membership(platformAdmin)).toBeUndefined();
    expect(await activeHeads()).toEqual([]);
    expect((await adminDb().collection(COLLECTIONS.fests).doc("fest1").get()).data()?.ownerId).toBe(platformAdmin.uid);
  });

  it("refuses to hand an event to a plain student, as before", async () => {
    expect((await transfer(platformAdmin, outsider.uid)).status).toBe(422);
    expect(await activeHeads()).toEqual([head.uid]);
  });
});
