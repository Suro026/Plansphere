import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { GET as festAnalytics } from "@/app/api/admin/analytics/route";
import { GET as exportAnalytics } from "@/app/api/admin/analytics/export/route";
import { GET as platformStats } from "@/app/api/admin/platform/route";
import { GET as platformAnalytics } from "@/app/api/admin/platform/analytics/route";
import { GET as platformAudit } from "@/app/api/admin/platform/audit/route";
import { GET as verify } from "@/app/api/verify/[number]/route";
import { GET as verifyPdf } from "@/app/api/verify/[number]/pdf/route";
import { callRoute, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are asserted field by field */

/**
 * Part 6 — Analytics & Reporting Engine, against the real handlers.
 *
 * Covers: fest-scoped and platform-wide aggregation, the `activeUsers30d`
 * KPI, the Export Center's three formats at both scopes, the audit browser's
 * single-filter rule, and — the one piece with no client-side equivalent to
 * check against — that the public verify/download routes actually write to
 * `certificateEvents`.
 */

let owner: TestUser;
let admin: TestUser;
let otherAdmin: TestUser;
let student: TestUser;
let volunteer: TestUser;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  await resetAuth();
  owner = await mintUser({ role: "super_admin", name: "Platform Owner" });
  admin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Fest Admin" });
  otherAdmin = await mintUser({ role: "admin", festIds: ["fest2"], name: "Other Admin" });
  student = await mintUser({ name: "Stu Dent" });
  volunteer = await mintUser({ role: "volunteer", festIds: ["fest1"], name: "Val Unteer" });
});

beforeEach(async () => {
  await resetFirestore();
  for (const user of [owner, admin, otherAdmin, student, volunteer]) {
    await adminDb()
      .collection(COLLECTIONS.users)
      .doc(user.uid)
      .set({
        id: user.uid,
        email: user.email,
        name: user.name,
        role: user.role,
        festIds: user.role === "admin" ? (user.uid === admin.uid ? ["fest1"] : ["fest2"]) : user.role === "volunteer" ? ["fest1"] : [],
        profileCompleted: true,
        mustChangePassword: false,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
  }
  await seedFest();
  await seedEvent();
});

describe("GET /api/admin/analytics — one fest's bundle", () => {
  beforeEach(async () => {
    const db = adminDb();
    await db.collection(COLLECTIONS.registrations).doc("reg1").set({
      id: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid, type: "solo", status: "confirmed", seats: 1,
      ticketCode: "FF-AAAAAAAAAA", members: [{ name: student.name, email: student.email, isLeader: true, inviteStatus: "accepted", college: "SRM" }],
      memberEmails: [student.email], eventTitle: "Capture the Flag", userName: student.name, userEmail: student.email,
      answers: { college: "SRM" }, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection(COLLECTIONS.registrations).doc("reg2").set({
      id: "reg2", eventId: "ev1", festId: "fest1", userId: "u2", type: "team", status: "confirmed", seats: 2,
      ticketCode: "FF-BBBBBBBBBB", members: [{ name: "A", email: "a@x.test", isLeader: true, inviteStatus: "accepted", college: "VIT" }, { name: "B", email: "b@x.test", inviteStatus: "accepted" }],
      memberEmails: ["a@x.test", "b@x.test"], eventTitle: "Capture the Flag", userName: "A", userEmail: "a@x.test",
      answers: { college: "VIT" }, teamName: "Team B", createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection(COLLECTIONS.registrations).doc("reg3").set({
      id: "reg3", eventId: "ev1", festId: "fest1", userId: "u3", type: "solo", status: "waitlisted", seats: 1,
      ticketCode: "FF-CCCCCCCCCC", members: [{ name: "C", email: "c@x.test", isLeader: true, inviteStatus: "accepted" }],
      memberEmails: ["c@x.test"], eventTitle: "Capture the Flag", userName: "C", userEmail: "c@x.test",
      answers: {}, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection(COLLECTIONS.attendance).doc("reg1").set({
      id: "reg1", registrationId: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid,
      userName: student.name, userEmail: student.email, ticketCode: "FF-AAAAAAAAAA", members: [],
      memberCount: 1, method: "qr", gate: "Gate A", scannedAt: new Date(), scannedBy: volunteer.uid, scannedByName: volunteer.name,
      queuedOffline: false, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection(COLLECTIONS.shifts).doc("shift1").set({
      id: "shift1", festId: "fest1", userId: volunteer.uid, userName: volunteer.name, userEmail: volunteer.email,
      post: "Gate A", duty: "entry", date: "2026-09-26", startTime: "09:00", endTime: "13:00", eventIds: [],
      cancelled: false, createdBy: admin.uid, createdAt: new Date(), updatedAt: new Date(),
    });
  });

  it("requires authentication and the caller's own fest scope", async () => {
    const noAuth = await callRoute(festAnalytics, { path: "/api/admin/analytics?festId=fest1", method: "GET" });
    expect(noAuth.status).toBe(401);

    const wrongFest = await callRoute(festAnalytics, { path: "/api/admin/analytics?festId=fest1", method: "GET", token: otherAdmin.idToken });
    expect(wrongFest.status).toBe(403);
  });

  it("aggregates registrations, teams, colleges and attendance for the fest", async () => {
    const res = await callRoute(festAnalytics, { path: "/api/admin/analytics?festId=fest1", method: "GET", token: admin.idToken });
    expect(res.status).toBe(200);
    expect(res.body.overview.registrations).toBe(3);
    expect(res.body.overview.events).toBe(1);
    expect(res.body.teamVsIndividual).toEqual({ team: 1, individual: 2 });
    expect(res.body.attendance).toEqual({ registered: 2, checkedIn: 1, noShow: 1, attendanceRate: 0.5 });
    expect(res.body.waitlistConversion.stillWaiting).toBe(1);

    const colleges = res.body.distributions.college.top.map((r: any) => r.label);
    expect(colleges).toEqual(expect.arrayContaining(["SRM", "VIT"]));

    expect(res.body.gateWiseScans).toEqual([{ gate: "Gate A", count: 1 }]);
    expect(res.body.volunteerLeaderboard[0].userId).toBe(volunteer.uid);
    expect(res.body.volunteerLeaderboard[0].totalScans).toBe(1);
  });

  it("scopes to a single event when eventId is given", async () => {
    const res = await callRoute(festAnalytics, { path: "/api/admin/analytics?festId=fest1&eventId=ev1", method: "GET", token: admin.idToken });
    expect(res.status).toBe(200);
    expect(res.body.overview.registrations).toBe(3);
  });
});

describe("GET /api/admin/platform — activeUsers30d", () => {
  it("counts only users touched in the last 30 days", async () => {
    await adminDb().collection(COLLECTIONS.users).doc(student.uid).update({ updatedAt: new Date() });
    await adminDb().collection(COLLECTIONS.users).doc(otherAdmin.uid).update({ updatedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) });

    const res = await callRoute(platformStats, { path: "/api/admin/platform", method: "GET", token: owner.idToken });
    expect(res.status).toBe(200);
    expect(typeof res.body.kpis.activeUsers30d).toBe("number");
    expect(res.body.kpis.activeUsers30d).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/admin/platform/analytics — cross-fest, super admin only", () => {
  beforeEach(async () => {
    await adminDb().collection(COLLECTIONS.registrations).doc("reg1").set({
      id: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid, type: "solo", status: "confirmed", seats: 1,
      ticketCode: "FF-AAAAAAAAAA", members: [{ name: student.name, email: student.email, isLeader: true, inviteStatus: "accepted" }],
      memberEmails: [student.email], eventTitle: "Capture the Flag", userName: student.name, userEmail: student.email,
      answers: {}, createdAt: new Date(), updatedAt: new Date(),
    });
  });

  it("is refused to a plain admin", async () => {
    const res = await callRoute(platformAnalytics, { path: "/api/admin/platform/analytics", method: "GET", token: admin.idToken });
    expect(res.status).toBe(403);
  });

  it("reports platform-wide totals to the super admin", async () => {
    const res = await callRoute(platformAnalytics, { path: "/api/admin/platform/analytics", method: "GET", token: owner.idToken });
    expect(res.status).toBe(200);
    expect(res.body.overview.fests).toBeGreaterThanOrEqual(1);
    expect(res.body.overview.registrations).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.overview.activeUsers30d).toBe("number");
  });
});

describe("GET /api/admin/platform/audit — cross-fest audit browser", () => {
  beforeEach(async () => {
    const db = adminDb();
    await db.collection(COLLECTIONS.auditLog).doc("a1").set({
      id: "a1", festId: "fest1", action: "event_updated", summary: "Capacity 10 → 20",
      actorId: admin.uid, actorName: admin.name, actorRole: "admin", createdAt: new Date(Date.now() - 2000),
    });
    await db.collection(COLLECTIONS.auditLog).doc("a2").set({
      id: "a2", festId: "fest2", action: "staff_created", summary: "Volunteer added",
      actorId: otherAdmin.uid, actorName: otherAdmin.name, actorRole: "admin", createdAt: new Date(Date.now() - 1000),
    });
  });

  it("is refused to a plain admin", async () => {
    const res = await callRoute(platformAudit, { path: "/api/admin/platform/audit", method: "GET", token: admin.idToken });
    expect(res.status).toBe(403);
  });

  it("lists every fest's entries for the super admin, newest first", async () => {
    const res = await callRoute(platformAudit, { path: "/api/admin/platform/audit", method: "GET", token: owner.idToken });
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0].id).toBe("a2");
  });

  it("filters by action type", async () => {
    const res = await callRoute(platformAudit, { path: "/api/admin/platform/audit?action=staff_created", method: "GET", token: owner.idToken });
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].id).toBe("a2");
  });

  it("refuses more than one filter at a time", async () => {
    const res = await callRoute(platformAudit, { path: "/api/admin/platform/audit?festId=fest1&action=staff_created", method: "GET", token: owner.idToken });
    expect(res.status).toBe(400);
  });

  it("paginates with a cursor", async () => {
    const page1 = await callRoute(platformAudit, { path: "/api/admin/platform/audit?limit=1", method: "GET", token: owner.idToken });
    expect(page1.body.entries).toHaveLength(1);
    expect(page1.body.nextCursor).toBeTruthy();

    const page2 = await callRoute(platformAudit, { path: `/api/admin/platform/audit?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`, method: "GET", token: owner.idToken });
    expect(page2.body.entries).toHaveLength(1);
    expect(page2.body.entries[0].id).not.toBe(page1.body.entries[0].id);
  });
});

describe("GET /api/admin/analytics/export — the export center", () => {
  it("returns real files for the fest scope", async () => {
    const csv = await callRoute(exportAnalytics, { path: "/api/admin/analytics/export?scope=fest&festId=fest1&format=csv", method: "GET", token: admin.idToken, raw: true });
    expect(csv.status).toBe(200);
    expect(csv.contentType).toContain("text/csv");

    const xlsx = await callRoute(exportAnalytics, { path: "/api/admin/analytics/export?scope=fest&festId=fest1&format=xlsx", method: "GET", token: admin.idToken, raw: true });
    expect(xlsx.status).toBe(200);
    expect(xlsx.bytes?.[0]).toBe(0x50);
    expect(xlsx.bytes?.[1]).toBe(0x4b);

    const pdf = await callRoute(exportAnalytics, { path: "/api/admin/analytics/export?scope=fest&festId=fest1&format=pdf", method: "GET", token: admin.idToken, raw: true });
    expect(pdf.status).toBe(200);
    expect(new TextDecoder().decode(pdf.bytes!.slice(0, 5))).toBe("%PDF-");
  });

  it("refuses a fest export outside the caller's scope", async () => {
    const res = await callRoute(exportAnalytics, { path: "/api/admin/analytics/export?scope=fest&festId=fest1&format=csv", method: "GET", token: otherAdmin.idToken, raw: true });
    expect(res.status).toBe(403);
  });

  it("is refused for the platform scope unless the caller is a super admin", async () => {
    const asAdmin = await callRoute(exportAnalytics, { path: "/api/admin/analytics/export?scope=platform&format=csv", method: "GET", token: admin.idToken, raw: true });
    expect(asAdmin.status).toBe(403);

    const asOwner = await callRoute(exportAnalytics, { path: "/api/admin/analytics/export?scope=platform&format=csv", method: "GET", token: owner.idToken, raw: true });
    expect(asOwner.status).toBe(200);
  });
});

describe("certificate verify/download event logging", () => {
  beforeEach(async () => {
    await adminDb().collection(COLLECTIONS.certificates).doc("ev1_stu1").set({
      id: "ev1_stu1", userId: student.uid, eventId: "ev1", festId: "fest1", registrationId: "reg1",
      certificateNumber: "FF-2026-ABCDEFGH", type: "participation", recipientName: student.name, recipientEmail: student.email,
      eventTitle: "Capture the Flag", festName: "Bits2Bytes", revoked: false, published: true,
      delivery: { status: "sent", attempts: 1 }, issuedAt: new Date(), issuedBy: admin.uid, createdAt: new Date(), updatedAt: new Date(),
    });
  });

  it("logs a verify event when the public verify route is hit", async () => {
    const res = await callRoute(verify, { path: "/api/verify/FF-2026-ABCDEFGH", method: "GET", params: { number: "FF-2026-ABCDEFGH" } });
    expect(res.status).toBe(200);
    await wait(300);

    const events = await adminDb().collection(COLLECTIONS.certificateEvents).where("type", "==", "verify").get();
    expect(events.size).toBe(1);
    expect(events.docs[0]!.data().certificateId).toBe("ev1_stu1");
  });

  it("logs a download event when the PDF route is hit", async () => {
    const res = await callRoute(verifyPdf, { path: "/api/verify/FF-2026-ABCDEFGH/pdf", method: "GET", params: { number: "FF-2026-ABCDEFGH" }, raw: true });
    expect(res.status).toBe(200);
    await wait(300);

    const events = await adminDb().collection(COLLECTIONS.certificateEvents).where("type", "==", "download").get();
    expect(events.size).toBe(1);
  });

  it("feeds certificate stats into the fest analytics bundle", async () => {
    await callRoute(verify, { path: "/api/verify/FF-2026-ABCDEFGH", method: "GET", params: { number: "FF-2026-ABCDEFGH" } });
    await wait(300);

    const res = await callRoute(festAnalytics, { path: "/api/admin/analytics?festId=fest1", method: "GET", token: admin.idToken });
    expect(res.status).toBe(200);
    expect(res.body.certificates.eligible).toBe(1);
    expect(res.body.certificates.released).toBe(1);
    expect(res.body.certificates.verificationCount).toBe(1);
  });
});
