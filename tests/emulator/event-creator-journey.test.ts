import { beforeAll, describe, expect, it } from "vitest";
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";
import { POST as registerEvent } from "@/app/api/register-event/route";
import { POST as decide } from "@/app/api/admin/fests/[id]/verification/route";
import { GET as myAccess } from "@/app/api/me/access/route";
import { PATCH as festAction } from "@/app/api/admin/fests/[id]/route";
import { POST as assignMember } from "@/app/api/admin/fests/[id]/members/route";
import { PATCH as updateMember } from "@/app/api/admin/fests/[id]/members/[uid]/route";
import { POST as createEvent } from "@/app/api/admin/events/route";
import { PATCH as updateEvent } from "@/app/api/admin/events/[id]/route";
import { GET as platform } from "@/app/api/admin/platform/route";
import { callRoute, freshToken, mintUser, resetAuth, resetFirestore, seedFest, type TestUser } from "./harness";

/**
 * The whole creator journey in one run, in the order a real person lives it, with the one token the applicant signed in
 * with before anything was approved (the browser is never signed out):
 *
 *   account -> create a college event -> pending -> platform approval -> refresh without signing out -> Event Super Admin
 *   -> invite a coordinator before any competition exists -> create competitions -> coordinator is limited to what was
 *   assigned -> nobody was ever made a platform super_admin -> the staff who were already there are untouched.
 */

const application = {
  organizationName: "Journey Institute",
  organizationType: "college" as const,
  contactEmail: "events@journey-institute.edu",
  city: "Chennai",
  state: "Tamil Nadu",
  name: "Journey Fest",
  description: "A journey through the whole product.",
  festType: "tech" as const,
  startDate: "2026-11-01",
  endDate: "2026-11-03",
  venue: "Main campus",
  expectedParticipants: 200,
  eventHead: { name: "Head Person", designation: "Convenor", phone: "+919000000000" },
};

const competition = (festId: string, slug: string) => ({
  festId,
  slug,
  title: slug,
  category: "hackathon",
  venue: "Lab 4",
  date: "2026-11-02",
  startTime: "10:00",
  eventType: "solo",
  teamSize: { min: 1, max: 1 },
  capacity: 40,
  gates: ["Gate A"],
  mealSlots: [{ date: "2026-11-02", mealType: "lunch", label: "Lunch" }],
});

const claimsOf = async (u: TestUser) => (await adminAuth().getUser(u.uid)).customClaims ?? {};
const profileOf = async (u: TestUser) => (await adminDb().collection(COLLECTIONS.users).doc(u.uid).get()).data() ?? {};

describe("college event creator journey, end to end", () => {
  let reviewer: TestUser;
  let legacyAdmin: TestUser;
  let gateVolunteer: TestUser;
  let creator: TestUser;
  let coordinator: TestUser;

  beforeAll(async () => {
    await resetAuth();
    await resetFirestore();
    reviewer = await mintUser({ role: "super_admin", name: "Platform Reviewer" });
    legacyAdmin = await mintUser({ role: "admin", festIds: ["other-fest"], name: "Legacy Admin" });
    gateVolunteer = await mintUser({ role: "volunteer", festIds: ["other-fest"], name: "Gate Volunteer" });
    creator = await mintUser({ name: "New Creator" }); // 1. a freshly registered account
    coordinator = await mintUser({ name: "Invited Coordinator" });
    const now = new Date();
    for (const u of [reviewer, legacyAdmin, gateVolunteer, creator, coordinator]) {
      const festIds = u === legacyAdmin || u === gateVolunteer ? ["other-fest"] : [];
      await adminDb().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, name: u.name, role: u.role, festIds, profileCompleted: true, mustChangePassword: false, emailVerified: true, createdAt: now, updatedAt: now });
    }
    await seedFest({ id: "other-fest", slug: "other-fest", name: "Other Fest" });
  });

  it("walks from a new account to a working Event Super Admin without a second sign-in", async () => {
    const legacyBefore = { claims: await claimsOf(legacyAdmin), profile: await profileOf(legacyAdmin) };
    const volunteerBefore = { claims: await claimsOf(gateVolunteer), profile: await profileOf(gateVolunteer) };
    const original = creator.idToken; // the only credential the applicant ever holds in this test

    // 2-3. Create a college event; it is submitted for manual approval and grants nothing yet.
    const applied = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: original, body: application });
    expect(applied.status).toBe(201);
    const festId = applied.body.fest.id as string;
    const pending = await adminDb().collection(COLLECTIONS.fests).doc(festId).get();
    expect(pending.data()).toMatchObject({ verification: { status: "pending" } });
    expect(pending.data()?.ownerId ?? null).toBeNull();
    expect((await callRoute(festAction, { method: "PATCH", path: "/x", params: { id: festId }, token: original, body: { action: "edit", changes: { description: "Too early" } } })).status).toBe(403);
    expect((await callRoute(myAccess, { path: "/api/me/access", token: original })).body.memberships).toEqual([]);

    // 4. Only the platform decides: the applicant cannot approve their own application.
    expect((await callRoute(decide, { method: "POST", path: "/x", params: { id: festId }, token: original, body: { action: "approve" } })).status).toBeGreaterThanOrEqual(400);
    const approved = await callRoute(decide, { method: "POST", path: "/x", params: { id: festId }, token: reviewer.idToken, body: { action: "approve" } });
    expect(approved.status).toBe(200);

    // 5. Refresh without signing out: the token they already hold works, and the access call repairs the claims and says
    //    to refresh, after which the new token carries the event role and the following check is quiet.
    const access = await callRoute(myAccess, { path: "/api/me/access", token: original });
    expect(access.status).toBe(200);
    expect(access.body.memberships).toEqual([expect.objectContaining({ festId, role: "head" })]);
    expect(access.body.refreshToken).toBe(true);
    expect((await claimsOf(creator)).fm).toEqual([festId]);
    const refreshed = await freshToken(creator);
    expect((await callRoute(myAccess, { path: "/api/me/access", token: refreshed })).body.refreshToken).toBe(false);

    // 6. The Event Super Admin runs their own event.
    expect((await callRoute(festAction, { method: "PATCH", path: "/x", params: { id: festId }, token: refreshed, body: { action: "edit", changes: { description: "Now mine" } } })).status).toBe(200);

    // 7. Invite a coordinator before a single competition exists.
    const invited = await callRoute(assignMember, { method: "POST", path: "/x", params: { id: festId }, token: refreshed, body: { email: coordinator.email, role: "coordinator", eventIds: [] } });
    expect(invited.status).toBe(201);

    // 8. Competitions are created afterwards; the coordinator reaches none until one is assigned, then only that one.
    const created = async (slug: string) => {
      const res = await callRoute(createEvent, { path: "/api/admin/events", token: refreshed, body: competition(festId, slug) });
      expect(res.status).toBe(201);
      return res.body.event.id as string;
    };
    const first = await created("first-contest");
    const second = await created("second-contest");
    const edit = (token: string, eventId: string) => callRoute(updateEvent, { method: "PATCH", path: "/x", params: { id: eventId }, token, body: { description: "Edited" } });

    const coordToken = await freshToken(coordinator);
    expect((await edit(coordToken, first)).status).toBe(403);
    expect((await edit(coordToken, second)).status).toBe(403);
    expect((await callRoute(updateMember, { method: "PATCH", path: "/x", params: { id: festId, uid: coordinator.uid }, token: refreshed, body: { eventIds: [first] } })).status).toBe(200);
    const assignedToken = await freshToken(coordinator);
    expect((await edit(assignedToken, first)).status).toBe(200);
    expect((await edit(assignedToken, second)).status).toBe(403);
    expect((await callRoute(festAction, { method: "PATCH", path: "/x", params: { id: festId }, token: assignedToken, body: { action: "edit", changes: { description: "Not theirs to change" } } })).status).toBe(403);

    // 9. Nobody became a platform super_admin: not the creator, not the coordinator; the platform area stays shut to both.
    for (const person of [creator, coordinator]) {
      const profile = await profileOf(person);
      expect(profile.role).not.toBe("super_admin");
      expect((await claimsOf(person)).role).not.toBe("super_admin");
    }
    expect((await callRoute(platform, { path: "/api/admin/platform", token: refreshed })).status).toBe(403);
    expect((await callRoute(platform, { path: "/api/admin/platform", token: assignedToken })).status).toBe(403);

    // 10. The staff who were already there are exactly as they were, and still run their own event.
    expect({ claims: await claimsOf(legacyAdmin), profile: await profileOf(legacyAdmin) }).toEqual(legacyBefore);
    expect({ claims: await claimsOf(gateVolunteer), profile: await profileOf(gateVolunteer) }).toEqual(volunteerBefore);
    const legacyToken = await freshToken(legacyAdmin);
    expect((await callRoute(festAction, { method: "PATCH", path: "/x", params: { id: "other-fest" }, token: legacyToken, body: { action: "edit", changes: { description: "Still mine" } } })).status).toBe(200);
    expect((await callRoute(festAction, { method: "PATCH", path: "/x", params: { id: festId }, token: legacyToken, body: { action: "edit", changes: { description: "Not mine" } } })).status).toBe(403);
  });
});
