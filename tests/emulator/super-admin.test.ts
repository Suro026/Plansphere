import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { POST as createFest, GET as listFests } from "@/app/api/admin/fests/route";
import { PATCH as festAction, DELETE as deleteFest } from "@/app/api/admin/fests/[id]/route";
import { GET as platformStats } from "@/app/api/admin/platform/route";
import { GET as myActivity } from "@/app/api/admin/platform/activity/route";
import { POST as resetPassword } from "@/app/api/admin/staff/[id]/password/route";
import { POST as createStaff } from "@/app/api/admin/staff/route";
import { GET as releasePreview, POST as publishCertificates } from "@/app/api/admin/certificates/publish/route";
import { POST as register } from "@/app/api/registrations/route";
import { PATCH as updateProfile } from "@/app/api/auth/profile/route";
import { callRoute, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are asserted field by field */

/**
 * The super admin module against the real handlers.
 *
 * One block per capability the spec describes, each asserting both halves:
 * what the owner may do, and that an admin — who runs a fest and is otherwise
 * powerful — may not.
 */

let owner: TestUser;
let admin: TestUser;
let otherAdmin: TestUser;
let student: TestUser;

const newFest = (over: Record<string, unknown> = {}) => ({
  name: "Ignitia 26",
  slug: "ignitia-26",
  organizationName: "Test College",
  venue: "Campus",
  city: "Chennai",
  startDate: "2026-11-01",
  endDate: "2026-11-03",
  festType: "cultural",
  academicYear: "2026-27",
  ...over,
});

beforeAll(async () => {
  await resetAuth();
  owner = await mintUser({ role: "super_admin", name: "Platform Owner" });
  admin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Fest Admin" });
  otherAdmin = await mintUser({ role: "admin", festIds: ["fest2"], name: "Other Admin" });
  student = await mintUser({ name: "Stu Dent" });
});

beforeEach(async () => {
  // Clearing Firestore takes the profile documents with it, and
  // `authenticate()` refuses a token whose account has no profile — so the
  // four identities are written back before anything calls a route.
  await resetFirestore();
  for (const user of [owner, admin, otherAdmin, student]) {
    await adminDb()
      .collection(COLLECTIONS.users)
      .doc(user.uid)
      .set({
        id: user.uid,
        uid: user.uid,
        email: user.email,
        name: user.name,
        role: user.role,
        festIds: user === admin ? ["fest1"] : user === otherAdmin ? ["fest2"] : [],
        profileCompleted: true,
        mustChangePassword: false,
        emailVerified: true,
        disabled: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(user.role === "student" ? { college: "Test College", phone: "+919000000000" } : {}),
      });
  }
  await seedFest();
  await seedFest({ id: "fest2", slug: "other", name: "Other Fest" });
});

/* ───────────── the container ───────────── */

describe("fest containers", () => {
  it("only a super admin creates one, and it arrives as a scoped draft", async () => {
    const refused = await callRoute(createFest, { path: "/api/admin/fests", token: admin.idToken, body: newFest() });
    expect(refused.status).toBe(403);

    const created = await callRoute(createFest, { path: "/api/admin/fests", token: owner.idToken, body: newFest() });
    expect(created.status).toBe(201);
    expect(created.body.fest).toMatchObject({
      name: "Ignitia 26",
      slug: "ignitia-26",
      festType: "cultural",
      academicYear: "2026-27",
      status: "draft",
      visibility: "public",
      registrationState: "open",
      ownerId: owner.uid,
    });
    // Every fest starts asking the default question set.
    expect(created.body.fest.registrationFields.builtIn.college).toBe("required");
  });

  it("refuses an address another fest already holds", async () => {
    const clash = await callRoute(createFest, { path: "/api/admin/fests", token: owner.idToken, body: newFest({ slug: "bits2bytes" }) });
    expect(clash.status).toBe(409);
  });

  it("records the creation in the audit log", async () => {
    await callRoute(createFest, { path: "/api/admin/fests", token: owner.idToken, body: newFest() });
    const log = await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", "fest_created").get();
    expect(log.size).toBe(1);
    expect(log.docs[0]!.data()).toMatchObject({ actorId: owner.uid, actorRole: "super_admin" });
  });

  it("archives and reopens, and an admin can do neither", async () => {
    expect((await callRoute(festAction, { path: "/api/admin/fests/fest1", method: "PATCH", params: { id: "fest1" }, token: admin.idToken, body: { action: "archive" } })).status).toBe(403);

    const archived = await callRoute(festAction, { path: "/api/admin/fests/fest1", method: "PATCH", params: { id: "fest1" }, token: owner.idToken, body: { action: "archive" } });
    expect(archived.status).toBe(200);
    expect(archived.body.fest.status).toBe("archived");
    expect(archived.body.fest.archivedAt).toBeTruthy();

    // Archiving twice is refused rather than silently repeated.
    expect((await callRoute(festAction, { path: "/api/admin/fests/fest1", method: "PATCH", params: { id: "fest1" }, token: owner.idToken, body: { action: "archive" } })).status).toBe(422);

    const reopened = await callRoute(festAction, { path: "/api/admin/fests/fest1", method: "PATCH", params: { id: "fest1" }, token: owner.idToken, body: { action: "reopen", status: "published" } });
    expect(reopened.body.fest.status).toBe("published");
    expect(reopened.body.fest.archivedAt).toBeUndefined();
  });

  it("transfers ownership and hands over the access that goes with it", async () => {
    const before = (await adminDb().collection(COLLECTIONS.users).doc(otherAdmin.uid).get()).data();
    expect(before?.festIds).toEqual(["fest2"]);

    const moved = await callRoute(festAction, {
      path: "/api/admin/fests/fest1",
      method: "PATCH",
      params: { id: "fest1" },
      token: owner.idToken,
      body: { action: "transfer", ownerId: otherAdmin.uid },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.fest.ownerId).toBe(otherAdmin.uid);

    const after = (await adminDb().collection(COLLECTIONS.users).doc(otherAdmin.uid).get()).data();
    expect(after?.festIds).toContain("fest1");
  });

  it("refuses to hand a fest to a student", async () => {
    const refused = await callRoute(festAction, {
      path: "/api/admin/fests/fest1",
      method: "PATCH",
      params: { id: "fest1" },
      token: owner.idToken,
      body: { action: "transfer", ownerId: student.uid },
    });
    expect(refused.status).toBe(422);
  });

  it("deletes an empty fest and refuses one with anything attached", async () => {
    await seedEvent();
    const blocked = await callRoute(deleteFest, { path: "/api/admin/fests/fest1", method: "DELETE", params: { id: "fest1" }, token: owner.idToken });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toContain("Archive it instead");

    const gone = await callRoute(deleteFest, { path: "/api/admin/fests/fest2", method: "DELETE", params: { id: "fest2" }, token: owner.idToken });
    expect(gone.status).toBe(200);
    expect((await adminDb().collection(COLLECTIONS.fests).doc("fest2").get()).exists).toBe(false);
  });

  it("scopes the list: an admin sees theirs, the owner sees everything", async () => {
    const mine = await callRoute(listFests, { path: "/api/admin/fests", method: "GET", token: admin.idToken });
    expect(mine.body.fests.map((f: any) => f.id)).toEqual(["fest1"]);

    const all = await callRoute(listFests, { path: "/api/admin/fests", method: "GET", token: owner.idToken });
    expect(all.body.fests.map((f: any) => f.id).sort()).toEqual(["fest1", "fest2"]);
  });
});

/* ───────────── what a fest asks for ───────────── */

describe("registration fields", () => {
  const fields = {
    builtIn: { phone: "required", college: "required", city: "required", github: "hidden" },
    custom: [{ key: "tshirt", label: "T-shirt size", type: "select", requirement: "required", options: ["S", "M", "L"] }],
  };

  it("is the owner's setting, not the running admin's", async () => {
    const refused = await callRoute(festAction, { path: "/api/admin/fests/fest1", method: "PATCH", params: { id: "fest1" }, token: admin.idToken, body: { action: "registrationFields", fields } });
    expect(refused.status).toBe(403);

    const saved = await callRoute(festAction, { path: "/api/admin/fests/fest1", method: "PATCH", params: { id: "fest1" }, token: owner.idToken, body: { action: "registrationFields", fields } });
    expect(saved.status).toBe(200);
    expect(saved.body.fest.registrationFields.custom[0].key).toBe("tshirt");
  });

  it("refuses two custom questions sharing a key", async () => {
    const clash = await callRoute(festAction, {
      path: "/api/admin/fests/fest1",
      method: "PATCH",
      params: { id: "fest1" },
      token: owner.idToken,
      body: { action: "registrationFields", fields: { builtIn: {}, custom: [{ key: "a", label: "A", type: "text", requirement: "optional" }, { key: "a", label: "B", type: "text", requirement: "optional" }] } },
    });
    expect(clash.status).toBe(422);
  });

  it("is enforced when a student registers, whatever the form sent", async () => {
    await callRoute(festAction, { path: "/api/admin/fests/fest1", method: "PATCH", params: { id: "fest1" }, token: owner.idToken, body: { action: "registrationFields", fields } });
    await seedEvent({ eventType: "solo", teamSize: { min: 1, max: 1 }, capacity: 10 });

    const missing = await callRoute(register, {
      path: "/api/registrations",
      token: student.idToken,
      body: { eventId: "ev1", members: [{ name: student.name, email: student.email }], answers: { phone: "+919000000000", college: "SRM" } },
    });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe("missing-answers");

    const ok = await callRoute(register, {
      path: "/api/registrations",
      token: student.idToken,
      body: {
        eventId: "ev1",
        members: [{ name: student.name, email: student.email }],
        answers: { phone: "+919000000000", college: "SRM", city: "Chennai", tshirt: "M", github: "https://github.com/x", injected: "nope" },
      },
    });
    expect(ok.status).toBe(201);

    const saved = (await adminDb().collection(COLLECTIONS.registrations).doc(ok.body.registration.id).get()).data();
    // Hidden and unknown keys never make it to storage.
    expect(saved?.answers).toEqual({ phone: "+919000000000", college: "SRM", city: "Chennai", tshirt: "M" });
  });

  it("closes every event at once when the fest switch is off", async () => {
    await seedEvent({ eventType: "solo", teamSize: { min: 1, max: 1 }, capacity: 10 });
    await callRoute(festAction, {
      path: "/api/admin/fests/fest1",
      method: "PATCH",
      params: { id: "fest1" },
      token: owner.idToken,
      body: { action: "edit", changes: { registrationState: "closed" } },
    });

    const refused = await callRoute(register, {
      path: "/api/registrations",
      token: student.idToken,
      body: { eventId: "ev1", members: [{ name: student.name, email: student.email }], answers: { phone: "+919000000000", college: "SRM" } },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain("closed");
  });
});

/* ───────────── admin accounts ───────────── */

describe("creating an admin", () => {
  // Auth survives `resetFirestore`, so every case needs an address of its own
  // — re-inviting an existing one is (correctly) a conflict.
  let seq = 0;
  const input = (over: Record<string, unknown> = {}) => {
    seq += 1;
    return { name: "New Admin", email: `new-admin-${seq}@plansphere.test`, role: "admin", festIds: ["fest1"], ...over };
  };

  it("issues a readable id and a temporary password, once", async () => {
    const created = await callRoute(createStaff, { path: "/api/admin/staff", token: owner.idToken, body: input() });
    expect(created.status).toBe(201);
    expect(created.body.user.staffCode).toMatch(/^ADM-\d{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
    expect(String(created.body.invite.temporaryPassword).length).toBeGreaterThanOrEqual(12);

    const doc = (await adminDb().collection(COLLECTIONS.users).doc(created.body.user.id).get()).data();
    expect(doc).toMatchObject({ role: "admin", festIds: ["fest1"], mustChangePassword: true, createdBy: owner.uid });
    // The password is nowhere in the document. That is the whole point.
    expect(JSON.stringify(doc)).not.toContain(created.body.invite.temporaryPassword);
  });

  it("is refused to an admin — only the owner creates admins", async () => {
    const refused = await callRoute(createStaff, { path: "/api/admin/staff", token: admin.idToken, body: input() });
    expect(refused.status).toBe(403);
  });

  it("regenerates the password, invalidating the old one", async () => {
    const created = await callRoute(createStaff, { path: "/api/admin/staff", token: owner.idToken, body: input() });
    expect(created.status).toBe(201);
    const id = created.body.user.id as string;
    const first = created.body.invite.temporaryPassword as string;

    const reissued = await callRoute(resetPassword, { path: `/api/admin/staff/${id}/password`, params: { id }, token: owner.idToken, body: {} });
    expect(reissued.status).toBe(200);
    expect(reissued.body.temporaryPassword).not.toBe(first);
    expect((await adminDb().collection(COLLECTIONS.users).doc(id).get()).data()?.mustChangePassword).toBe(true);

    const log = await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", "staff_password_reset").get();
    expect(log.size).toBe(1);
  });

  it("will not reset a student's password from the staff desk", async () => {
    const refused = await callRoute(resetPassword, { path: `/api/admin/staff/${student.uid}/password`, params: { id: student.uid }, token: owner.idToken, body: {} });
    expect(refused.status).toBe(422);
  });
});

/* ───────────── the dashboard ───────────── */

describe("the dashboard", () => {
  it("counts the platform and is refused to an admin", async () => {
    expect((await callRoute(platformStats, { path: "/api/admin/platform", method: "GET", token: admin.idToken })).status).toBe(403);

    const stats = await callRoute(platformStats, { path: "/api/admin/platform", method: "GET", token: owner.idToken });
    expect(stats.status).toBe(200);
    expect(stats.body.kpis.fests).toBe(2);
    expect(stats.body.kpis.admins).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(stats.body.recentFests)).toBe(true);
    expect(Array.isArray(stats.body.recentRegistrations)).toBe(true);
  });

  it("shows an account its own activity and nobody else's", async () => {
    await callRoute(createFest, { path: "/api/admin/fests", token: owner.idToken, body: newFest() });

    const mine = await callRoute(myActivity, { path: "/api/admin/platform/activity", method: "GET", token: owner.idToken });
    expect(mine.body.entries.some((e: any) => e.action === "fest_created")).toBe(true);

    const theirs = await callRoute(myActivity, { path: "/api/admin/platform/activity", method: "GET", token: admin.idToken });
    expect(theirs.body.entries).toEqual([]);
  });
});

/* ───────────── the profile ───────────── */

describe("the owner's profile", () => {
  it("saves its own fields and cannot be used to self-promote", async () => {
    const saved = await callRoute(updateProfile, {
      path: "/api/auth/profile",
      method: "PATCH",
      token: admin.idToken,
      body: { name: "Renamed Admin", organization: "Test College", bio: "Runs the tech fest.", role: "super_admin", festIds: ["fest2"] },
    });
    expect(saved.status).toBe(200);

    const doc = (await adminDb().collection(COLLECTIONS.users).doc(admin.uid).get()).data();
    expect(doc).toMatchObject({ name: "Renamed Admin", organization: "Test College", role: "admin", festIds: ["fest1"] });
  });
});

/* ───────────── certificate release ───────────── */

describe("certificate release", () => {
  beforeEach(async () => {
    await seedEvent({ eventType: "solo", teamSize: { min: 1, max: 1 }, capacity: 10, status: "completed" });
  });

  it("an admin may preview the list; only the owner may publish", async () => {
    const preview = await callRoute(releasePreview, { path: "/api/admin/certificates/publish?eventId=ev1", method: "GET", token: admin.idToken });
    expect(preview.status).toBe(200);
    expect(preview.body.canPublish).toBe(false);

    const refused = await callRoute(publishCertificates, { path: "/api/admin/certificates/publish", token: admin.idToken, body: { eventId: "ev1" } });
    expect(refused.status).toBe(403);
  });

  it("publishes only the recipients chosen, and records it", async () => {
    // One attended entry, so there is exactly one eligible recipient.
    const reg = await adminDb().collection(COLLECTIONS.registrations).doc("reg1");
    await reg.set({
      id: "reg1",
      eventId: "ev1",
      festId: "fest1",
      userId: student.uid,
      type: "solo",
      status: "confirmed",
      seats: 1,
      ticketCode: "FF-AAAAAAAAAA",
      members: [{ name: student.name, email: student.email, userId: student.uid, isLeader: true, inviteStatus: "accepted" }],
      memberEmails: [student.email],
      eventTitle: "Capture the Flag",
      userName: student.name,
      userEmail: student.email,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await adminDb().collection(COLLECTIONS.attendance).doc("reg1").set({
      id: "reg1",
      registrationId: "reg1",
      eventId: "ev1",
      festId: "fest1",
      userId: student.uid,
      ticketCode: "FF-AAAAAAAAAA",
      scannedAt: new Date(),
      scannedBy: admin.uid,
      method: "qr",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const preview = await callRoute(releasePreview, { path: "/api/admin/certificates/publish?eventId=ev1", method: "GET", token: owner.idToken });
    expect(preview.body.canPublish).toBe(true);
    expect(preview.body.recipients).toHaveLength(1);
    expect(preview.body.recipients[0]).toMatchObject({ userId: student.uid, issued: false, released: false });

    const released = await callRoute(publishCertificates, {
      path: "/api/admin/certificates/publish",
      token: owner.idToken,
      body: { eventId: "ev1", userIds: [student.uid] },
    });
    expect(released.status).toBe(200);
    expect(released.body.published).toBe(1);

    const certificates = await adminDb().collection(COLLECTIONS.certificates).where("eventId", "==", "ev1").get();
    expect(certificates.size).toBe(1);
    expect(certificates.docs[0]!.data()).toMatchObject({ published: true, publishedBy: owner.uid, userId: student.uid });

    const log = await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", "certificates_published").get();
    expect(log.size).toBe(1);

    // Releasing again is a no-op rather than a second email.
    const again = await callRoute(publishCertificates, { path: "/api/admin/certificates/publish", token: owner.idToken, body: { eventId: "ev1" } });
    expect(again.body.published).toBe(0);
    expect((await adminDb().collection(COLLECTIONS.certificates).where("eventId", "==", "ev1").get()).size).toBe(1);
  });

  it("refuses to release for an event that has not finished", async () => {
    await seedEvent({ id: "ev2", slug: "quiz", status: "published" });
    const refused = await callRoute(publishCertificates, { path: "/api/admin/certificates/publish", token: owner.idToken, body: { eventId: "ev2" } });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain("completed");
  });
});
