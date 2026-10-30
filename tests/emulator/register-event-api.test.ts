import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";
import { POST as registerEvent } from "@/app/api/register-event/route";
import { POST as createStaff } from "@/app/api/admin/staff/route";
import { callRoute, freshToken, mintUser, resetAuth, resetFirestore, type TestUser } from "./harness";

/**
 * POST /api/register-event through the real handler against the Firebase Auth
 * and Firestore emulators — the self-service path any signed-in account may
 * use, with no invitation and no existing super admin involved.
 */

let student: TestUser;
let otherStudent: TestUser;
let volunteer: TestUser;
let scopedAdmin: TestUser;
let superAdmin: TestUser;

/** The fests a seeded staff account starts out scoped to. */
const SEEDED_SCOPE = ["other-fest"];

const validBody = (name: string) => ({
  // Step 1 — organization
  organizationName: "Test Institute of Technology",
  organizationType: "college" as const,
  organizationWebsite: "https://test-institute.edu",
  contactEmail: "events@test-institute.edu",
  city: "Chennai",
  state: "Tamil Nadu",
  // Step 2 — event
  name,
  description: "A three-day tech and culture fest.",
  festType: "tech" as const,
  startDate: "2026-11-01",
  endDate: "2026-11-03",
  venue: "Main campus",
  expectedParticipants: 500,
  // Step 3 — event head
  eventHead: {
    name: "Meena R. Kumar",
    designation: "Cultural Secretary",
    phone: "+919000000000",
    linkedin: "https://linkedin.com/in/meena-kumar",
  },
});

beforeAll(async () => {
  await resetAuth();
  student = await mintUser({ name: "Future Event Head" });
  otherStudent = await mintUser({ name: "Another Event Head" });
  volunteer = await mintUser({ role: "volunteer", festIds: SEEDED_SCOPE, name: "Existing Volunteer" });
  scopedAdmin = await mintUser({ role: "admin", festIds: SEEDED_SCOPE, name: "Existing Admin" });
  superAdmin = await mintUser({ role: "super_admin", name: "Platform Owner" });
});

beforeEach(async () => {
  await resetFirestore();
  // resetFirestore() wipes the `users` profile docs mintUser() wrote in
  // beforeAll (Auth accounts and their custom claims are untouched) — put
  // them back to their minted state before each test.
  for (const u of [student, otherStudent, volunteer, scopedAdmin, superAdmin]) {
    const festIds = u === scopedAdmin || u === volunteer ? SEEDED_SCOPE : [];
    await adminDb()
      .collection(COLLECTIONS.users)
      .doc(u.uid)
      .set({
        id: u.uid,
        email: u.email,
        name: u.name,
        role: u.role,
        festIds,
        profileCompleted: true,
        mustChangePassword: false,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(u.role === "student" ? { college: "Test College", phone: "+919000000000" } : {}),
      });
  }
});

describe("authorization", () => {
  it("requires a signed-in caller", async () => {
    const res = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", body: validBody("No Token Fest") });
    expect(res.status).toBe(401);
  });

  it("rejects an empty body", async () => {
    const res = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: student.idToken, body: { name: "" } });
    expect(res.status).toBe(400);
  });

  it("rejects a body missing a required step-3 field", async () => {
    const body: Record<string, unknown> = validBody("Missing Event Head");
    delete body.eventHead;
    const res = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: student.idToken, body });
    expect(res.status).toBe(400);
  });
});

describe("a plain student registers an event", () => {
  it("files a pending application: a draft with no owner, and the applicant's access unchanged", async () => {
    const before = await accessOf(student);
    const res = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: student.idToken, body: validBody("Aurora 26") });
    expect(res.status).toBe(201);
    expect(res.body.fest.createdBy).toBe(student.uid);
    expect(res.body.fest.status).toBe("draft");
    expect(res.body.fest.slug).toBe("aurora-26");
    // No Event Head yet, and the response says plainly where the application stands.
    expect(res.body.fest).not.toHaveProperty("ownerId");
    expect(res.body.fest.verification.status).toBe("pending");
    expect(res.body.application).toMatchObject({ festId: res.body.fest.id, status: "pending" });

    // Nothing was granted: not in the profile the API reads, and not in the claim the rules read.
    expect(await accessOf(student)).toEqual(before);
    expect(before.profile.role).toBe("student");
  });

  it("stores every wizard field on the fest document, as a pending application", async () => {
    const res = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: student.idToken, body: validBody("Full Wizard Fest") });
    expect(res.status).toBe(201);
    const fest = res.body.fest;
    expect(fest.organizationName).toBe("Test Institute of Technology");
    expect(fest.organizationType).toBe("college");
    expect(fest.organizationWebsite).toBe("https://test-institute.edu");
    expect(fest.contactEmail).toBe("events@test-institute.edu");
    expect(fest.city).toBe("Chennai");
    expect(fest.state).toBe("Tamil Nadu");
    expect(fest.venue).toBe("Main campus");
    expect(fest.expectedParticipants).toBe(500);
    // The event head's own details are not on the (world-readable once published) fest; they are on a server-only document.
    expect(fest).not.toHaveProperty("eventHead");
    const stored = await adminDb().collection(COLLECTIONS.festPrivate).doc(fest.id).get();
    expect(stored.data()?.eventHead).toMatchObject({ name: "Meena R. Kumar", designation: "Cultural Secretary", phone: "+919000000000" });
    // Publication and review are separate: it is a draft, and under review.
    expect(fest.status).toBe("draft");
    expect(fest.verification.status).toBe("pending");
    expect(fest).not.toHaveProperty("verified");
    expect(fest).not.toHaveProperty("approvalStatus");
    expect(fest).not.toHaveProperty("pendingReview");
  });

  it("auto-suffixes a slug collision", async () => {
    const first = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: student.idToken, body: validBody("Duplicate Name") });
    const second = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: otherStudent.idToken, body: validBody("Duplicate Name") });
    expect(first.body.fest.slug).toBe("duplicate-name");
    expect(second.body.fest.slug).toBe("duplicate-name-2");
  });

  it("a pending applicant cannot invite staff for their own application, even with a fresh sign-in", async () => {
    const created = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: student.idToken, body: validBody("Owner Invites") });
    const ownFestId = created.body.fest.id as string;

    const token = await freshToken(student);
    const invite = await callRoute(createStaff, {
      method: "POST",
      path: "/api/admin/staff",
      token,
      body: { name: "Co-admin", email: `co-admin-${Date.now()}@plansphere.test`, role: "admin", festIds: [ownFestId] },
    });
    expect(invite.status).toBe(403);
  });
});

/** What an account can do, from both places the server and the rules read it: the profile and the Auth claim. */
const accessOf = async (user: TestUser) => {
  const profile = (await adminDb().collection(COLLECTIONS.users).doc(user.uid).get()).data();
  const claims = (await adminAuth().getUser(user.uid)).customClaims ?? {};
  return { profile: { role: profile?.role, festIds: profile?.festIds }, claim: { role: claims.role, festIds: claims.festIds } };
};

/** Nothing was written: no fest, no private details, no audit entry. */
const expectNothingCreated = async () => {
  expect((await adminDb().collection(COLLECTIONS.fests).get()).size).toBe(0);
  expect((await adminDb().collection(COLLECTIONS.festPrivate).get()).size).toBe(0);
  expect((await adminDb().collection(COLLECTIONS.auditLog).get()).size).toBe(0);
};

describe("registering an event never changes what existing staff can do", () => {
  it("refuses a volunteer, who must not become an admin of the fest they work at", async () => {
    const before = await accessOf(volunteer);
    expect(before).toEqual({ profile: { role: "volunteer", festIds: SEEDED_SCOPE }, claim: { role: "volunteer", festIds: SEEDED_SCOPE } });

    const res = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: volunteer.idToken, body: validBody("Volunteer Fest") });

    expect(res.status).toBe(403);
    expect(await accessOf(volunteer)).toEqual(before);
    await expectNothingCreated();
  });

  it("refuses an admin, whose scope must not be widened to another fest", async () => {
    const before = await accessOf(scopedAdmin);

    const res = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: scopedAdmin.idToken, body: validBody("Second Fest") });

    expect(res.status).toBe(403);
    expect(await accessOf(scopedAdmin)).toEqual(before);
    await expectNothingCreated();
  });

  it("lets a student file more than one application, and none of them grants anything", async () => {
    const applicant = await mintUser({ name: "Two Application Student" });
    const before = await accessOf(applicant);

    const first = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: applicant.idToken, body: validBody("First Fest") });
    const second = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: applicant.idToken, body: validBody("Second Fest") });

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body.fest.id).not.toBe(second.body.fest.id);
    expect(await accessOf(applicant)).toEqual(before);
    expect((await adminDb().collection(COLLECTIONS.fests).get()).size).toBe(2);
  });

  it("answers staff the same way whatever they send, so a malformed body cannot probe for anything", async () => {
    const res = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: volunteer.idToken, body: { name: "" } });
    expect(res.status).toBe(403);
  });

  it("leaves a student's access alone, including a stale scope on their profile, and never merges the new event into it", async () => {
    const stale = await mintUser({ name: "Student With Leftover Scope" });
    await adminDb().collection(COLLECTIONS.users).doc(stale.uid).set({ festIds: ["stale-fest"] }, { merge: true });
    const before = await accessOf(stale);

    const res = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: stale.idToken, body: validBody("Clean Scope Fest") });
    expect(res.status).toBe(201);

    expect(await accessOf(stale)).toEqual(before);
    expect((await accessOf(stale)).profile.festIds).not.toContain(res.body.fest.id);
  });
});

describe("a platform super admin registers an event", () => {
  it("records ownership without needing a claims change", async () => {
    const res = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: superAdmin.idToken, body: validBody("Owner-Recorded Fest") });
    expect(res.status).toBe(201);
    expect(res.body.fest.ownerId).toBe(superAdmin.uid);
    // The platform has nobody to ask: its own registration is recorded as approved, by the platform, not by a review.
    expect(res.body.fest.verification).toMatchObject({ status: "approved", basis: "platform" });

    const userDoc = await adminDb().collection(COLLECTIONS.users).doc(superAdmin.uid).get();
    expect(userDoc.data()?.role).toBe("super_admin");
    // Not scoped to the fest either: a super admin is unscoped by definition, and the claim is left as it was.
    expect(userDoc.data()?.festIds).toEqual([]);
    expect((await adminAuth().getUser(superAdmin.uid)).customClaims).toEqual({ role: "super_admin", festIds: [] });
  });
});
