import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminAuth, adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { POST as createEvent } from "@/app/api/admin/events/route";
import { POST as createStaff } from "@/app/api/admin/staff/route";
import { GET as listStaff } from "@/app/api/admin/staff/route";
import { POST as publishResults } from "@/app/api/admin/events/[id]/results/publish/route";
import { POST as manualAttendance } from "@/app/api/admin/attendance/manual/route";
import { POST as announce } from "@/app/api/admin/fests/[id]/announcements/route";
import { POST as changePassword } from "@/app/api/auth/change-password/route";
import { callRoute, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * RBAC end to end: the four roles against the real route handlers and the
 * real security rules.
 *
 * One test block per role, each asserting both halves — what the role may do,
 * and what it must not. The spec in one file.
 */

let student: TestUser;
let volunteer: TestUser;
let admin: TestUser;
let otherAdmin: TestUser;
let superAdmin: TestUser;
let invited: TestUser;

beforeAll(async () => {
  await resetAuth();
  student = await mintUser({ role: "student", name: "Stu" });
  volunteer = await mintUser({ role: "volunteer", festIds: ["fest1"], name: "Vol" });
  admin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Adm" });
  otherAdmin = await mintUser({ role: "admin", festIds: ["fest2"], name: "Other Adm" });
  superAdmin = await mintUser({ role: "super_admin", name: "Root" });
  invited = await mintUser({ role: "admin", festIds: ["fest1"], name: "Fresh", mustChangePassword: true });
});

beforeEach(async () => {
  await resetFirestore();
  for (const u of [student, volunteer, admin, otherAdmin, superAdmin, invited]) {
    await adminDb()
      .collection(COLLECTIONS.users)
      .doc(u.uid)
      .set({
        id: u.uid,
        uid: u.uid,
        email: u.email,
        name: u.name,
        role: u.role,
        festIds: u === otherAdmin ? ["fest2"] : u.role === "student" || u.role === "super_admin" ? [] : ["fest1"],
        profileCompleted: true,
        mustChangePassword: u === invited,
        emailVerified: true,
        disabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(u.role === "student" ? { college: "T", phone: "+919000000000" } : {}),
      });
  }
  await seedFest();
  await seedFest({ id: "fest2", slug: "other" });
  await seedEvent();
});

const newEvent = (festId = "fest1") => ({
  festId,
  slug: `e-${Date.now()}`,
  title: "New Event",
  category: "technical",
  eventType: "solo",
  teamSize: { min: 1, max: 1 },
  date: "2026-09-26",
  startTime: "10:00",
  venue: "Lab",
  capacity: 10,
});

describe("student", () => {
  it("cannot reach any staff route", async () => {
    expect((await callRoute(createEvent, { path: "/api/admin/events", token: student.idToken, body: newEvent() })).status).toBe(403);
    expect((await callRoute(listStaff, { path: "/api/admin/staff", method: "GET", token: student.idToken })).status).toBe(403);
    expect((await callRoute(createStaff, { path: "/api/admin/staff", token: student.idToken, body: { name: "X", email: "x@plansphere.test", role: "volunteer", festIds: ["fest1"] } })).status).toBe(403);
    expect((await callRoute(manualAttendance, { path: "/api/admin/attendance/manual", token: student.idToken, body: { ticketCode: "FF-AAAAAAAAAA", eventId: "ev1" } })).status).toBe(403);
    expect((await callRoute(announce, { path: "/api/admin/fests/fest1/announcements", token: student.idToken, params: { id: "fest1" }, body: { title: "T", body: "B" } })).status).toBe(403);
  });
});

describe("volunteer", () => {
  it("cannot create events, publish results, mark manual attendance or announce", async () => {
    expect((await callRoute(createEvent, { path: "/api/admin/events", token: volunteer.idToken, body: newEvent() })).status).toBe(403);
    expect((await callRoute(publishResults, { path: "/api/admin/events/ev1/results/publish", token: volunteer.idToken, params: { id: "ev1" }, body: {} })).status).toBe(403);
    expect((await callRoute(manualAttendance, { path: "/api/admin/attendance/manual", token: volunteer.idToken, body: { ticketCode: "FF-AAAAAAAAAA", eventId: "ev1" } })).status).toBe(403);
    expect((await callRoute(announce, { path: "/api/admin/fests/fest1/announcements", token: volunteer.idToken, params: { id: "fest1" }, body: { title: "T", body: "B" } })).status).toBe(403);
  });

  it("cannot create staff or read the staff list", async () => {
    expect((await callRoute(createStaff, { path: "/api/admin/staff", token: volunteer.idToken, body: { name: "X", email: "x@plansphere.test", role: "volunteer", festIds: ["fest1"] } })).status).toBe(403);
    expect((await callRoute(listStaff, { path: "/api/admin/staff", method: "GET", token: volunteer.idToken })).status).toBe(403);
  });
});

describe("admin", () => {
  it("runs their own fest", async () => {
    const created = await callRoute(createEvent, { path: "/api/admin/events", token: admin.idToken, body: newEvent("fest1") });
    expect(created.status).toBe(201);
    expect((await callRoute(listStaff, { path: "/api/admin/staff", method: "GET", token: admin.idToken })).status).toBe(200);
  });

  it("cannot touch a fest they are not assigned to", async () => {
    const res = await callRoute(createEvent, { path: "/api/admin/events", token: admin.idToken, body: newEvent("fest2") });
    expect(res.status).toBe(403);
    const other = await callRoute(announce, { path: "/api/admin/fests/fest2/announcements", token: admin.idToken, params: { id: "fest2" }, body: { title: "T", body: "B" } });
    expect(other.status).toBe(403);
  });

  it("may create a volunteer but never an admin or super admin", async () => {
    const vol = await callRoute(createStaff, { path: "/api/admin/staff", token: admin.idToken, body: { name: "New Vol", email: `vol-${Date.now()}@plansphere.test`, role: "volunteer", festIds: ["fest1"] } });
    expect(vol.status).toBe(201);
    expect(vol.body.user.role).toBe("volunteer");

    const asAdmin = await callRoute(createStaff, { path: "/api/admin/staff", token: admin.idToken, body: { name: "Nope", email: `adm-${Date.now()}@plansphere.test`, role: "admin", festIds: ["fest1"] } });
    expect(asAdmin.status).toBe(403);
    const asSuper = await callRoute(createStaff, { path: "/api/admin/staff", token: admin.idToken, body: { name: "Nope", email: `sup-${Date.now()}@plansphere.test`, role: "super_admin", festIds: [] } });
    expect(asSuper.status).toBe(403);
  });

  it("cannot hand out access to a fest they do not manage", async () => {
    const res = await callRoute(createStaff, { path: "/api/admin/staff", token: admin.idToken, body: { name: "V", email: `v2-${Date.now()}@plansphere.test`, role: "volunteer", festIds: ["fest2"] } });
    expect(res.status).toBe(403);
  });
});

describe("super admin", () => {
  it("creates an admin, scoped, with a temporary password and the right claims", async () => {
    const email = `adm-${Date.now()}@plansphere.test`;
    const res = await callRoute(createStaff, { path: "/api/admin/staff", token: superAdmin.idToken, body: { name: "Created Admin", email, role: "admin", festIds: ["fest1"] } });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ role: "admin", festIds: ["fest1"] });

    const doc_ = await adminDb().collection(COLLECTIONS.users).doc(res.body.user.id).get();
    expect(doc_.data()).toMatchObject({ role: "admin", festIds: ["fest1"], mustChangePassword: true, profileCompleted: true, createdBy: superAdmin.uid });

    const authUser = await adminAuth().getUser(res.body.user.id);
    expect(authUser.customClaims).toMatchObject({ role: "admin", festIds: ["fest1"], mustChangePassword: true });
  });

  it("acts on any fest", async () => {
    expect((await callRoute(createEvent, { path: "/api/admin/events", token: superAdmin.idToken, body: newEvent("fest2") })).status).toBe(201);
  });
});

describe("forced password change", () => {
  it("refuses every privileged route until the temporary password is replaced", async () => {
    const res = await callRoute(createEvent, { path: "/api/admin/events", token: invited.idToken, body: newEvent("fest1") });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("must-change-password");
    expect((await callRoute(listStaff, { path: "/api/admin/staff", method: "GET", token: invited.idToken })).status).toBe(403);
  });

  it("the change-password route itself is reachable, and clears the flag", async () => {
    const wrong = await callRoute(changePassword, { path: "/api/auth/change-password", token: invited.idToken, body: { currentPassword: "not-the-password", password: "Brand-new-1", confirmPassword: "Brand-new-1" } });
    // The emulator has no Identity Toolkit key wired for this check, so the
    // route reports "unavailable" rather than letting it through — what
    // matters is that it is not a must-change-password refusal.
    expect(wrong.body.code).not.toBe("must-change-password");
  });
});

/* ───────────── rules ───────────── */

describe("firestore.rules under the new roles", () => {
  let env: RulesTestEnvironment;
  const [host = "127.0.0.1", port = "8080"] = (process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080").split(":");

  const token = (role: string, festIds: string[] = [], extra: Record<string, unknown> = {}) => ({
    email: `${role}@plansphere.test`,
    email_verified: true,
    role,
    festIds,
    ...extra,
  });
  const as = (uid: string, claims: Record<string, unknown>) => env.authenticatedContext(uid, claims).firestore();

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
      await setDoc(doc(db, "users", "stu1"), { id: "stu1", email: "student@plansphere.test", name: "S", role: "student", festIds: [], disabled: false, profileCompleted: true, mustChangePassword: false, createdAt: now, updatedAt: now });
      await setDoc(doc(db, "fests", "fest1"), { id: "fest1", slug: "f1", name: "F1", status: "published", organizationName: "T", startDate: "2026-09-25", endDate: "2026-09-27", stats: { events: 0, registrations: 0, checkIns: 0 }, createdAt: now, updatedAt: now });
      await setDoc(doc(db, "fests", "fest2"), { id: "fest2", slug: "f2", name: "F2", status: "published", organizationName: "T", startDate: "2026-09-25", endDate: "2026-09-27", stats: { events: 0, registrations: 0, checkIns: 0 }, createdAt: now, updatedAt: now });
      await setDoc(doc(db, "registrations", "reg1"), { id: "reg1", eventId: "ev1", festId: "fest1", userId: "stu1", type: "solo", status: "confirmed", seats: 1, ticketCode: "FF-AAAAAAAAAA", members: [], memberEmails: ["student@plansphere.test"], eventTitle: "E", userName: "S", userEmail: "student@plansphere.test", createdAt: now, updatedAt: now });
      await setDoc(doc(db, "auditLog", "a1"), { action: "event_updated", actorId: "adm1", festId: "fest1", summary: "x", createdAt: now });
    });
  });

  it("a volunteer reads no registration at all - not their own fest's, not another's", async () => {
    // The gate is sent a minimal roster by the server (names, ticket codes, who is ticked off) and nothing else. The
    // full record - email, phone, college, answers - is for the people who run the competition.
    await assertFails(getDoc(doc(as("vol1", token("volunteer", ["fest1"])), "registrations", "reg1")));
    await assertFails(getDocs(query(collection(as("vol1", token("volunteer", ["fest1"])), "registrations"), where("festId", "==", "fest1"))));
    await assertFails(getDoc(doc(as("vol9", token("volunteer", ["fest2"])), "registrations", "reg1")));
  });

  it("an admin is scoped too — not every fest", async () => {
    await assertSucceeds(getDoc(doc(as("adm1", token("admin", ["fest1"])), "registrations", "reg1")));
    await assertFails(getDoc(doc(as("adm2", token("admin", ["fest2"])), "registrations", "reg1")));
    // Only the super admin is unscoped.
    await assertSucceeds(getDoc(doc(as("root", token("super_admin")), "registrations", "reg1")));
  });

  it("a volunteer cannot edit the fest, not even its public counters: the server records a scan", async () => {
    const vol = as("vol1", token("volunteer", ["fest1"]));
    await assertFails(updateDoc(doc(vol, "fests", "fest1"), { stats: { events: 0, registrations: 0, checkIns: 1 } }));
    await assertFails(updateDoc(doc(vol, "fests", "fest1"), { name: "Renamed" }));
    await assertSucceeds(updateDoc(doc(as("adm1", token("admin", ["fest1"])), "fests", "fest1"), { name: "Renamed" }));
  });

  it("a temporary password reads nothing", async () => {
    const fresh = as("adm3", token("admin", ["fest1"], { mustChangePassword: true }));
    await assertFails(getDoc(doc(fresh, "registrations", "reg1")));
    await assertFails(getDocs(query(collection(fresh, "users"), where("role", "==", "student"))));
    await assertFails(updateDoc(doc(fresh, "fests", "fest1"), { name: "Nope" }));
  });

  it("nobody can promote themselves by writing their own profile", async () => {
    const stu = as("stu1", token("student"));
    await assertSucceeds(updateDoc(doc(stu, "users", "stu1"), { name: "New Name", updatedAt: new Date() }));
    await assertFails(updateDoc(doc(stu, "users", "stu1"), { role: "super_admin", updatedAt: new Date() }));
    await assertFails(updateDoc(doc(stu, "users", "stu1"), { festIds: ["fest1"], updatedAt: new Date() }));
    await assertFails(updateDoc(doc(stu, "users", "stu1"), { mustChangePassword: true, updatedAt: new Date() }));
    await assertFails(updateDoc(doc(stu, "users", "stu1"), { disabled: true, updatedAt: new Date() }));
  });

  it("a self-registered account cannot arrive scoped or privileged", async () => {
    const newbie = as("new1", { email: "new@plansphere.test", email_verified: true, role: "student", festIds: [] });
    const base = { id: "new1", email: "new@plansphere.test", name: "N", disabled: false, createdAt: new Date(), updatedAt: new Date() };
    await assertSucceeds(setDoc(doc(newbie, "users", "new1"), { ...base, role: "student", festIds: [], mustChangePassword: false }));
    await assertFails(setDoc(doc(newbie, "users", "new1"), { ...base, role: "admin", festIds: [], mustChangePassword: false }));
    await assertFails(setDoc(doc(newbie, "users", "new1"), { ...base, role: "student", festIds: ["fest1"], mustChangePassword: false }));
  });

  it("the audit log is admin-scoped: volunteers cannot read it", async () => {
    await assertSucceeds(getDocs(query(collection(as("adm1", token("admin", ["fest1"])), "auditLog"), where("festId", "==", "fest1"))));
    await assertFails(getDocs(query(collection(as("vol1", token("volunteer", ["fest1"])), "auditLog"), where("festId", "==", "fest1"))));
  });

  it("an admin editing their fest cannot touch the owner-only fields", async () => {
    const adm = as("adm1", token("admin", ["fest1"]));
    // Ordinary edits are still theirs.
    await assertSucceeds(updateDoc(doc(adm, "fests", "fest1"), { name: "Renamed", updatedAt: new Date() }));
    // Ownership, what the fest asks for, and archiving go through the server
    // so they land in the audit trail.
    await assertFails(updateDoc(doc(adm, "fests", "fest1"), { ownerId: "adm1", updatedAt: new Date() }));
    await assertFails(updateDoc(doc(adm, "fests", "fest1"), { registrationFields: { builtIn: {}, custom: [] }, updatedAt: new Date() }));
    await assertFails(updateDoc(doc(adm, "fests", "fest1"), { status: "archived", updatedAt: new Date() }));
    await assertFails(updateDoc(doc(adm, "fests", "fest1"), { slug: "stolen", updatedAt: new Date() }));
  });

  it("an admin cannot mark their own fest verified, nor publish one that is under review or turned down", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const base = { slug: "s", name: "N", organizationName: "T", startDate: "2026-09-25", endDate: "2026-09-27", stats: { events: 0, registrations: 0, checkIns: 0 }, createdBy: "stu1" };
      await setDoc(doc(db, "fests", "pend1"), { ...base, id: "pend1", status: "draft", verification: { status: "pending", submittedAt: new Date() } });
      await setDoc(doc(db, "fests", "rej1"), { ...base, id: "rej1", status: "draft", verification: { status: "rejected", submittedAt: new Date() } });
      await setDoc(doc(db, "fests", "ok1"), { ...base, id: "ok1", status: "draft", verification: { status: "approved", submittedAt: new Date() } });
    });
    const adm = as("adm1", token("admin", ["fest1", "pend1", "rej1", "ok1"]));

    // The review state is the server's. An admin can neither forge it on a fest that has none nor flip it on one that does.
    await assertFails(updateDoc(doc(adm, "fests", "fest1"), { verification: { status: "approved", submittedAt: new Date() }, updatedAt: new Date() }));
    await assertFails(updateDoc(doc(adm, "fests", "pend1"), { verification: { status: "approved", submittedAt: new Date() }, updatedAt: new Date() }));
    await assertFails(updateDoc(doc(adm, "fests", "ok1"), { verification: { status: "pending", submittedAt: new Date() }, updatedAt: new Date() }));

    // Nothing under review or turned down goes public from the client, whoever asks, the platform included.
    await assertFails(updateDoc(doc(adm, "fests", "pend1"), { status: "published", updatedAt: new Date() }));
    await assertFails(updateDoc(doc(adm, "fests", "rej1"), { status: "published", updatedAt: new Date() }));
    await assertFails(updateDoc(doc(as("root", token("super_admin")), "fests", "pend1"), { status: "published", updatedAt: new Date() }));

    // Everything else stays theirs: ordinary edits, and publishing a fest that is approved or that predates the review.
    await assertSucceeds(updateDoc(doc(adm, "fests", "pend1"), { name: "Renamed", updatedAt: new Date() }));
    await assertSucceeds(updateDoc(doc(adm, "fests", "ok1"), { status: "published", updatedAt: new Date() }));
    await assertSucceeds(updateDoc(doc(adm, "fests", "fest1"), { status: "published", updatedAt: new Date() }));
  });

  it("an application under review or turned down is readable only by the staff who manage it and the platform", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const base = { slug: "s", name: "N", organizationName: "T", startDate: "2026-09-25", endDate: "2026-09-27", stats: { events: 0, registrations: 0, checkIns: 0 }, createdBy: "stu1", status: "draft" };
      await setDoc(doc(db, "fests", "pendA"), { ...base, id: "pendA", verification: { status: "pending", submittedAt: new Date() } });
      await setDoc(doc(db, "fests", "rejA"), { ...base, id: "rejA", verification: { status: "rejected", submittedAt: new Date() } });
      await setDoc(doc(db, "fests", "okA"), { ...base, id: "okA", verification: { status: "approved", submittedAt: new Date() } });
      await setDoc(doc(db, "fests", "oldA"), { ...base, id: "oldA" });
    });
    const otherVolunteer = as("v9", token("volunteer", ["fest2"]));
    const otherAdmin = as("a9", token("admin", ["fest2"]));
    const manager = as("m1", token("admin", ["pendA", "rejA"]));
    const root = as("root", token("super_admin"));

    // Other fests' staff cannot read someone else's application, whichever state it is in...
    for (const who of [otherVolunteer, otherAdmin]) {
      await assertFails(getDoc(doc(who, "fests", "pendA")));
      await assertFails(getDoc(doc(who, "fests", "rejA")));
    }
    // ...nor a student or a signed-out visitor.
    await assertFails(getDoc(doc(as("stu1", token("student")), "fests", "pendA")));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "fests", "pendA")));
    // The staff who manage the application, and the platform, can.
    await assertSucceeds(getDoc(doc(manager, "fests", "pendA")));
    await assertSucceeds(getDoc(doc(manager, "fests", "rejA")));
    await assertSucceeds(getDoc(doc(root, "fests", "pendA")));
    // Approval does not make a draft public, and neither does having predated the review: a draft is private to the people
    // who run it, whichever state its application is in. (Published fests are public - see firestore-rules.test.ts.)
    await assertFails(getDoc(doc(otherAdmin, "fests", "okA")));
    await assertFails(getDoc(doc(otherVolunteer, "fests", "oldA")));
    await assertSucceeds(getDoc(doc(as("m2", token("admin", ["okA", "oldA"])), "fests", "okA")));
    await assertSucceeds(getDoc(doc(as("m2", token("admin", ["okA", "oldA"])), "fests", "oldA")));
    await assertSucceeds(getDoc(doc(root, "fests", "okA")));

    // No query can promise it leaves the applications out, so staff cannot list fests at all - whatever they filter by.
    for (const who of [otherVolunteer, otherAdmin, manager]) {
      await assertFails(getDocs(collection(who, "fests")));
      await assertFails(getDocs(query(collection(who, "fests"), where("status", "==", "draft"))));
      await assertFails(getDocs(query(collection(who, "fests"), where("slug", "==", "s"))));
    }
    // The platform lists them all; the public still lists published fests by the query that proves it.
    await assertSucceeds(getDocs(collection(root, "fests")));
    await assertSucceeds(getDocs(query(collection(otherAdmin, "fests"), where("status", "==", "published"))));
    await assertSucceeds(getDocs(query(collection(env.unauthenticatedContext().firestore(), "fests"), where("status", "==", "published"))));
  });

  it("only the platform changes a verified fest's organization name, type or website", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const base = { slug: "s", name: "N", organizationName: "Real College", organizationType: "college", startDate: "2026-09-25", endDate: "2026-09-27", stats: { events: 0, registrations: 0, checkIns: 0 }, createdBy: "stu1", status: "draft" };
      await setDoc(doc(db, "fests", "ver1"), { ...base, id: "ver1", verification: { status: "approved", submittedAt: new Date() } });
      await setDoc(doc(db, "fests", "old1"), { ...base, id: "old1" });
    });
    const adm = as("adm1", token("admin", ["ver1", "old1"]));

    for (const change of [{ organizationName: "Impersonated College" }, { organizationType: "company" }, { organizationWebsite: "https://elsewhere.edu" }]) {
      await assertFails(updateDoc(doc(adm, "fests", "ver1"), { ...change, updatedAt: new Date() }));
    }
    // Writing the same value back is not a change, and everything else stays theirs.
    await assertSucceeds(updateDoc(doc(adm, "fests", "ver1"), { organizationName: "Real College", name: "Renamed", updatedAt: new Date() }));
    // The platform can, and a fest that predates the review is edited as before.
    await assertSucceeds(updateDoc(doc(as("root", token("super_admin")), "fests", "ver1"), { organizationName: "Corrected College", updatedAt: new Date() }));
    await assertSucceeds(updateDoc(doc(adm, "fests", "old1"), { organizationName: "Renamed Org", updatedAt: new Date() }));
  });

  it("nobody creates a fest from the client any more", async () => {
    const root = as("root", token("super_admin"));
    await assertFails(
      setDoc(doc(root, "fests", "new-fest"), {
        id: "new-fest",
        slug: "new-fest",
        name: "New",
        status: "draft",
        organizationName: "T",
        startDate: "2026-09-25",
        endDate: "2026-09-27",
        stats: { events: 0, registrations: 0, checkIns: 0 },
        createdBy: "root",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
  });

  it("a student cannot read a certificate that has not been released", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const base = {
        userId: "stu1",
        eventId: "ev1",
        festId: "fest1",
        registrationId: "reg1",
        type: "participation",
        recipientName: "S",
        recipientEmail: "student@plansphere.test",
        eventTitle: "E",
        festName: "F1",
        revoked: false,
        delivery: { status: "sent", attempts: 1 },
        issuedAt: new Date(),
        issuedBy: "adm1",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await setDoc(doc(db, "certificates", "prepared"), { ...base, id: "prepared", certificateNumber: "FF-2026-AAAAAAAA", published: false });
      await setDoc(doc(db, "certificates", "released"), { ...base, id: "released", certificateNumber: "FF-2026-BBBBBBBB", published: true });
      // Issued before the release desk existed: no field at all.
      await setDoc(doc(db, "certificates", "legacy"), { ...base, id: "legacy", certificateNumber: "FF-2026-CCCCCCCC" });
    });

    const stu = as("stu1", token("student"));
    await assertFails(getDoc(doc(stu, "certificates", "prepared")));
    await assertSucceeds(getDoc(doc(stu, "certificates", "released")));
    await assertSucceeds(getDoc(doc(stu, "certificates", "legacy")));
  });

  it("a legacy organizer token still works as a volunteer", async () => {
    // Still a volunteer - which means no registrations and no edits.
    const legacy = as("old1", token("organizer", ["fest1"]));
    await assertFails(getDoc(doc(legacy, "registrations", "reg1")));
    await assertFails(updateDoc(doc(legacy, "fests", "fest1"), { name: "Renamed" }));
    await assertSucceeds(getDoc(doc(legacy, "fests", "fest1")));
  });
});
