import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { callRoute, mintUser, resetAuth, resetFirestore, type TestUser } from "./harness";

/**
 * An email that cannot be sent must never cost anyone their application or undo a decision. The mail provider is replaced
 * with one that always throws; the application, the approval and the rejection still go through, and the applicant's
 * status page (GET /api/register-event) stays the source of truth.
 */

const { sent } = vi.hoisted(() => ({ sent: { attempts: 0 } }));

vi.mock("@/server/email", () => ({
  EMAIL_TEMPLATES: [],
  emailService: () => ({
    name: "broken",
    canSend: true,
    send: async () => {
      sent.attempts += 1;
      throw new Error("provider down");
    },
    sendMany: async () => {
      sent.attempts += 1;
      throw new Error("provider down");
    },
  }),
}));

const { POST: registerEvent, GET: myApplications } = await import("@/app/api/register-event/route");
const { POST: decide } = await import("@/app/api/admin/fests/[id]/verification/route");

let reviewer: TestUser;
let applicant: TestUser;

const body = (name: string) => ({
  organizationName: "Test Institute of Technology",
  organizationType: "college" as const,
  contactEmail: "events@test-institute.edu",
  city: "Chennai",
  state: "Tamil Nadu",
  name,
  description: "A fest.",
  festType: "tech" as const,
  startDate: "2026-11-01",
  endDate: "2026-11-03",
  venue: "Main campus",
  expectedParticipants: 500,
  eventHead: { name: "Meena R. Kumar", designation: "Cultural Secretary", phone: "+919000000000" },
});

const seed = (u: TestUser) =>
  adminDb().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, name: u.name, role: u.role, festIds: [], profileCompleted: true, mustChangePassword: false, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });

beforeAll(async () => {
  await resetAuth();
  reviewer = await mintUser({ role: "super_admin", name: "Reviewer" });
  applicant = await mintUser({ name: "Applicant" });
});

beforeEach(async () => {
  sent.attempts = 0;
  await resetFirestore();
  await seed(reviewer);
  await seed(applicant);
});

describe("when email cannot be delivered", () => {
  it("still records the application, the approval and the rejection", async () => {
    const submitted = await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: applicant.idToken, body: body("Resilient Fest") });
    expect(submitted.status).toBe(201);
    const festId = submitted.body.fest.id as string;
    expect(sent.attempts).toBeGreaterThan(0);
    expect((await adminDb().collection(COLLECTIONS.fests).doc(festId).get()).data()?.verification?.status).toBe("pending");

    const approved = await callRoute(decide, { method: "POST", path: "/x", params: { id: festId }, token: reviewer.idToken, body: { action: "approve" } });
    expect(approved.status).toBe(200);
    expect((await adminDb().collection(COLLECTIONS.festMembers).doc(`${festId}__${applicant.uid}`).get()).data()).toMatchObject({ role: "head", status: "active" });

    const second = (await callRoute(registerEvent, { method: "POST", path: "/api/register-event", token: applicant.idToken, body: body("Second Resilient Fest") })).body.fest.id as string;
    const rejected = await callRoute(decide, { method: "POST", path: "/x", params: { id: second }, token: reviewer.idToken, body: { action: "reject", reason: "Please add your website." } });
    expect(rejected.status).toBe(200);

    // The applicant can still see exactly where each application stands.
    const mine = await callRoute(myApplications, { path: "/api/register-event", token: applicant.idToken });
    expect(mine.body.applications.map((a: { status: string }) => a.status).sort()).toEqual(["approved", "rejected"]);
  });
});
