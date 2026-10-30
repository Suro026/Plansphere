import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { POST as createEvent } from "@/app/api/admin/events/route";
import { PATCH as updateEvent, DELETE as deleteEvent } from "@/app/api/admin/events/[id]/route";
import { POST as duplicateEvent } from "@/app/api/admin/events/[id]/duplicate/route";
import { GET as exportRegistrations } from "@/app/api/admin/registrations/export/route";
import { POST as createStaff } from "@/app/api/admin/staff/route";
import { PATCH as updateStaff, DELETE as deleteStaff } from "@/app/api/admin/staff/[id]/route";
import { POST as createFest } from "@/app/api/admin/fests/route";
import { PATCH as updateFest } from "@/app/api/admin/fests/[id]/route";
import { POST as publishCertificates } from "@/app/api/admin/certificates/publish/route";
import { GET as platformStats } from "@/app/api/admin/platform/route";
import { callRoute, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";


/**
 * The Admin event-management module against the real handlers: duplication,
 * archiving, the registration export, volunteer assignment, and — the
 * spec's own "SECURITY" section — every one of the five things an admin
 * must not be able to do.
 */

let owner: TestUser;
let admin: TestUser;
let otherAdmin: TestUser;
let student: TestUser;

beforeAll(async () => {
  await resetAuth();
  owner = await mintUser({ role: "super_admin", name: "Platform Owner" });
  admin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Fest Admin" });
  otherAdmin = await mintUser({ role: "admin", festIds: ["fest2"], name: "Other Admin" });
  student = await mintUser({ name: "Stu Dent" });
});

beforeEach(async () => {
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
      });
  }
  await seedFest();
  await seedFest({ id: "fest2", slug: "other", name: "Other Fest" });
});

/* ───────────── duplicate ───────────── */

describe("duplicating an event", () => {
  it("copies the shape into a fresh draft with no registrations and its own slug", async () => {
    await seedEvent();
    const result = await callRoute(duplicateEvent, { path: "/api/admin/events/ev1/duplicate", params: { id: "ev1" }, token: admin.idToken });
    expect(result.status).toBe(201);
    expect(result.body.event).toMatchObject({ slug: "ctf-copy", status: "draft", registrationOpen: false, registeredCount: 0, venue: "Lab 4" });
    expect(result.body.event.id).not.toBe("ev1");

    const fest = (await adminDb().collection(COLLECTIONS.fests).doc("fest1").get()).data();
    // seedFest's own fixture starts the counter at 1 (for the seeded event);
    // duplicating a second event bumps it to 2.
    expect(fest?.stats.events).toBe(2);

    const log = await adminDb().collection(COLLECTIONS.auditLog).where("eventId", "==", result.body.event.id).get();
    expect(log.size).toBe(1);
  });

  it("finds the next free slug when a copy already exists", async () => {
    await seedEvent();
    await callRoute(duplicateEvent, { path: "/api/admin/events/ev1/duplicate", params: { id: "ev1" }, token: admin.idToken });
    const second = await callRoute(duplicateEvent, { path: "/api/admin/events/ev1/duplicate", params: { id: "ev1" }, token: admin.idToken });
    expect(second.body.event.slug).toBe("ctf-copy-2");
  });

  it("is refused for a fest the caller does not manage", async () => {
    await seedEvent();
    const refused = await callRoute(duplicateEvent, { path: "/api/admin/events/ev1/duplicate", params: { id: "ev1" }, token: otherAdmin.idToken });
    expect(refused.status).toBe(403);
  });
});

/* ───────────── archive ───────────── */

describe("archiving an event", () => {
  it("an admin can archive and restore their own event — no super admin needed", async () => {
    await seedEvent();
    const archived = await callRoute(updateEvent, {
      path: "/api/admin/events/ev1",
      method: "PATCH",
      params: { id: "ev1" },
      token: admin.idToken,
      body: { visibility: "archived" },
    });
    expect(archived.status).toBe(200);
    expect(archived.body.event.visibility).toBe("archived");
    expect(archived.body.event.archivedAt).toBeTruthy();

    const restored = await callRoute(updateEvent, {
      path: "/api/admin/events/ev1",
      method: "PATCH",
      params: { id: "ev1" },
      token: admin.idToken,
      body: { visibility: "public" },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.event.visibility).toBe("public");
    expect(restored.body.event.archivedAt).toBeUndefined();
  });

  it("is refused for a fest the caller does not manage", async () => {
    await seedEvent();
    const refused = await callRoute(updateEvent, {
      path: "/api/admin/events/ev1",
      method: "PATCH",
      params: { id: "ev1" },
      token: otherAdmin.idToken,
      body: { visibility: "archived" },
    });
    expect(refused.status).toBe(403);
  });
});

/* ───────────── delete refused with registrations ───────────── */

describe("deleting an event", () => {
  it("is refused while a registration exists, and succeeds once none do", async () => {
    await seedEvent();
    await adminDb().collection(COLLECTIONS.registrations).doc("reg1").set({
      id: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid, type: "solo", status: "confirmed", seats: 1,
      ticketCode: "FF-AAAAAAAAAA", members: [], memberEmails: [], eventTitle: "Capture the Flag", userName: student.name, userEmail: student.email,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const blocked = await callRoute(deleteEvent, { path: "/api/admin/events/ev1", method: "DELETE", params: { id: "ev1" }, token: admin.idToken });
    expect(blocked.status).toBe(422);

    await adminDb().collection(COLLECTIONS.registrations).doc("reg1").delete();
    const gone = await callRoute(deleteEvent, { path: "/api/admin/events/ev1", method: "DELETE", params: { id: "ev1" }, token: admin.idToken });
    expect(gone.status).toBe(200);
  });
});

/* ───────────── categories ───────────── */

describe("event categories", () => {
  it("accepts a built-in category and a custom one alike", async () => {
    const builtIn = await callRoute(createEvent, {
      path: "/api/admin/events",
      token: admin.idToken,
      body: { festId: "fest1", slug: "hack-2026", title: "Hack 2026", category: "hackathon", venue: "Lab", date: "2026-09-26", startTime: "09:00", eventType: "solo", teamSize: { min: 1, max: 1 } },
    });
    expect(builtIn.status).toBe(201);
    expect(builtIn.body.event.category).toBe("hackathon");

    const custom = await callRoute(createEvent, {
      path: "/api/admin/events",
      token: admin.idToken,
      body: { festId: "fest1", slug: "robotics-derby", title: "Robotics Derby", category: "Robotics", venue: "Lab", date: "2026-09-26", startTime: "09:00", eventType: "solo", teamSize: { min: 1, max: 1 } },
    });
    expect(custom.status).toBe(201);
    // Normalised to lowercase for consistent filtering.
    expect(custom.body.event.category).toBe("robotics");
  });
});

/* ───────────── the registration export ───────────── */

describe("the registration export", () => {
  beforeEach(async () => {
    await seedEvent();
    await adminDb().collection(COLLECTIONS.registrations).doc("reg1").set({
      id: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid, type: "solo", status: "confirmed", seats: 1,
      ticketCode: "FF-AAAAAAAAAA", members: [{ name: student.name, email: student.email, isLeader: true, inviteStatus: "accepted", college: "SRM" }],
      memberEmails: [student.email], eventTitle: "Capture the Flag", userName: student.name, userEmail: student.email,
      answers: { college: "SRM" },
      createdAt: new Date(), updatedAt: new Date(),
    });
  });

  it("requires authentication and the caller's own fest scope", async () => {
    const noAuth = await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest1", method: "GET" });
    expect(noAuth.status).toBe(401);

    const wrongFest = await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest1", method: "GET", token: otherAdmin.idToken });
    expect(wrongFest.status).toBe(403);
  });

  it("returns a CSV with the college column populated", async () => {
    const res = await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest1&format=csv", method: "GET", token: admin.idToken, raw: true });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/csv");
    const text = new TextDecoder().decode(res.bytes!);
    expect(text).toContain("SRM");
    expect(text).toContain("College");
  });

  it("returns a real xlsx (a zip) and a real pdf, not just a renamed csv", async () => {
    const xlsx = await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest1&format=xlsx", method: "GET", token: admin.idToken, raw: true });
    expect(xlsx.status).toBe(200);
    expect(xlsx.contentType).toContain("spreadsheetml");
    expect(xlsx.bytes?.[0]).toBe(0x50); // "P" of the PK zip signature
    expect(xlsx.bytes?.[1]).toBe(0x4b);

    const pdf = await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest1&format=pdf", method: "GET", token: admin.idToken, raw: true });
    expect(pdf.status).toBe(200);
    expect(pdf.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(pdf.bytes!.slice(0, 5))).toBe("%PDF-");
  });

  it("applies the college filter", async () => {
    const match = await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest1&format=csv&college=SRM", method: "GET", token: admin.idToken, raw: true });
    expect(new TextDecoder().decode(match.bytes!)).toContain("SRM");

    const noMatch = await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest1&format=csv&college=VIT", method: "GET", token: admin.idToken, raw: true });
    expect(new TextDecoder().decode(noMatch.bytes!)).not.toContain(student.name);
  });

  it("shows a checked-in attendance status, not the raw registration status", async () => {
    await adminDb().collection(COLLECTIONS.attendance).doc("reg1").set({
      id: "reg1", registrationId: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid,
      userName: student.name, userEmail: student.email, ticketCode: "FF-AAAAAAAAAA", members: [],
      memberCount: 1, method: "qr", scannedAt: new Date(), scannedBy: admin.uid,
      queuedOffline: false, createdAt: new Date(), updatedAt: new Date(),
    });

    const res = await callRoute(exportRegistrations, { path: "/api/admin/registrations/export?festId=fest1&format=csv", method: "GET", token: admin.idToken, raw: true });
    expect(res.status).toBe(200);
    const parseCsvRow = (line: string) => line.replace(/^﻿/, "").split('","').map((cell) => cell.replace(/^"|"$/g, ""));
    const [headerLine, dataLine] = new TextDecoder().decode(res.bytes!).trim().split("\r\n");
    const header = parseCsvRow(headerLine!);
    const dataRow = parseCsvRow(dataLine!);
    const statusCol = header.indexOf("Status");
    const attendanceCol = header.indexOf("Attendance");
    expect(statusCol).toBeGreaterThanOrEqual(0);
    expect(attendanceCol).toBeGreaterThanOrEqual(0);
    expect(dataRow[statusCol]).toBe("checked_in");
    expect(dataRow[attendanceCol]).not.toBe("");
  });
});

/* ───────────── volunteer assignment ───────────── */

describe("volunteer assignment", () => {
  it("assigns two volunteers to the same gate, then removes one and disables the other", async () => {
    const first = await callRoute(createStaff, {
      path: "/api/admin/staff",
      token: admin.idToken,
      body: { name: "Vol One", email: "vol-one@plansphere.test", role: "volunteer", festIds: ["fest1"] },
    });
    const second = await callRoute(createStaff, {
      path: "/api/admin/staff",
      token: admin.idToken,
      body: { name: "Vol Two", email: "vol-two@plansphere.test", role: "volunteer", festIds: ["fest1"] },
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const now = new Date();
    await adminDb().collection(COLLECTIONS.shifts).doc("shift1").set({
      id: "shift1", festId: "fest1", userId: first.body.user.id, userName: "Vol One", userEmail: "vol-one@plansphere.test",
      post: "Gate A", duty: "entry", date: "2026-09-26", startTime: "08:00", endTime: "13:00", eventIds: [], cancelled: false,
      createdBy: admin.uid, createdAt: now, updatedAt: now,
    });
    await adminDb().collection(COLLECTIONS.shifts).doc("shift2").set({
      id: "shift2", festId: "fest1", userId: second.body.user.id, userName: "Vol Two", userEmail: "vol-two@plansphere.test",
      post: "Gate A", duty: "entry", date: "2026-09-26", startTime: "08:00", endTime: "13:00", eventIds: [], cancelled: false,
      createdBy: admin.uid, createdAt: now, updatedAt: now,
    });

    const atGateA = await adminDb().collection(COLLECTIONS.shifts).where("festId", "==", "fest1").where("post", "==", "Gate A").get();
    expect(atGateA.size).toBe(2);

    // Remove one assignment.
    await adminDb().collection(COLLECTIONS.shifts).doc("shift1").delete();
    const remaining = await adminDb().collection(COLLECTIONS.shifts).where("festId", "==", "fest1").where("post", "==", "Gate A").get();
    expect(remaining.size).toBe(1);

    // Disable the other volunteer's account.
    const disabled = await callRoute(updateStaff, {
      path: `/api/admin/staff/${second.body.user.id}`,
      method: "PATCH",
      params: { id: second.body.user.id },
      token: admin.idToken,
      body: { disabled: true },
    });
    expect(disabled.status).toBe(200);
    const doc = await adminDb().collection(COLLECTIONS.users).doc(second.body.user.id).get();
    expect(doc.data()?.disabled).toBe(true);
  });

  it("an admin creating a volunteer can only scope them to fests the admin manages", async () => {
    const refused = await callRoute(createStaff, {
      path: "/api/admin/staff",
      token: admin.idToken,
      body: { name: "Cross Fest", email: "cross@plansphere.test", role: "volunteer", festIds: ["fest2"] },
    });
    expect(refused.status).toBe(403);
  });
});

/* ───────────── security: what an admin must never be able to do ───────────── */

describe("admin security boundaries", () => {
  it("cannot create a fest container", async () => {
    const res = await callRoute(createFest, {
      path: "/api/admin/fests",
      token: admin.idToken,
      body: { name: "New Fest", slug: "new-fest", organizationName: "T", venue: "V", city: "C", startDate: "2026-11-01", endDate: "2026-11-02" },
    });
    expect(res.status).toBe(403);
  });

  it("cannot create an admin or super admin account", async () => {
    const asAdmin = await callRoute(createStaff, {
      path: "/api/admin/staff",
      token: admin.idToken,
      body: { name: "Wannabe", email: "wannabe@plansphere.test", role: "admin", festIds: ["fest1"] },
    });
    expect(asAdmin.status).toBe(403);

    const asSuper = await callRoute(createStaff, {
      path: "/api/admin/staff",
      token: admin.idToken,
      body: { name: "Wannabe Two", email: "wannabe2@plansphere.test", role: "super_admin", festIds: [] },
    });
    expect(asSuper.status).toBe(403);
  });

  it("cannot publish certificates", async () => {
    await seedEvent({ status: "completed" });
    const res = await callRoute(publishCertificates, {
      path: "/api/admin/certificates/publish",
      token: admin.idToken,
      body: { eventId: "ev1" },
    });
    expect(res.status).toBe(403);
  });

  it("cannot edit a fest they do not manage", async () => {
    const write = await callRoute(updateFest, {
      path: "/api/admin/fests/fest2",
      method: "PATCH",
      params: { id: "fest2" },
      token: admin.idToken,
      body: { action: "edit", changes: { name: "Hijacked" } },
    });
    expect(write.status).toBe(403);
  });

  it("cannot edit an event belonging to a fest they do not manage", async () => {
    await seedEvent({ id: "ev-other", slug: "other-event", festId: "fest2" });
    const write = await callRoute(updateEvent, {
      path: "/api/admin/events/ev-other",
      method: "PATCH",
      params: { id: "ev-other" },
      token: admin.idToken,
      body: { title: "Hijacked" },
    });
    expect(write.status).toBe(403);
  });

  it("cannot read the platform-wide dashboard", async () => {
    const res = await callRoute(platformStats, { path: "/api/admin/platform", method: "GET", token: admin.idToken });
    expect(res.status).toBe(403);
  });

  it("cannot delete a staff account outright with delete()", async () => {
    const created = await callRoute(createStaff, {
      path: "/api/admin/staff",
      token: admin.idToken,
      body: { name: "Removable", email: "removable@plansphere.test", role: "volunteer", festIds: ["fest1"] },
    });
    // An admin CAN remove their own volunteer — this is the boundary check
    // the other way: they cannot remove an admin or super admin account.
    const refused = await callRoute(deleteStaff, {
      path: `/api/admin/staff/${owner.uid}`,
      method: "DELETE",
      params: { id: owner.uid },
      token: admin.idToken,
    });
    expect(refused.status).toBe(403);

    const allowed = await callRoute(deleteStaff, {
      path: `/api/admin/staff/${created.body.user.id}`,
      method: "DELETE",
      params: { id: created.body.user.id },
      token: admin.idToken,
    });
    expect(allowed.status).toBe(200);
  });
});
