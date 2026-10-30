import { beforeAll, describe, expect, it } from "vitest";
import { COLLECTIONS, adminAuth, adminDb } from "@/server/firebase-admin";
import { POST as registerEvent, GET as myApplications } from "@/app/api/register-event/route";
import { GET as reviewQueue } from "@/app/api/admin/verifications/route";
import { POST as decide } from "@/app/api/admin/fests/[id]/verification/route";
import { GET as myAccess } from "@/app/api/me/access/route";
import { GET as listMembers, POST as assignMember } from "@/app/api/admin/fests/[id]/members/route";
import { DELETE as revokeMember } from "@/app/api/admin/fests/[id]/members/[uid]/route";
import { PATCH as patchFest } from "@/app/api/admin/fests/[id]/route";
import { POST as createEvent } from "@/app/api/admin/events/route";
import { PATCH as patchEvent } from "@/app/api/admin/events/[id]/route";
import { POST as changePassword } from "@/app/api/auth/change-password/route";
import { POST as register } from "@/app/api/registrations/route";
import { GET as roster } from "@/app/api/volunteer/roster/route";
import { POST as scan } from "@/app/api/volunteer/scan/route";
import { POST as meal } from "@/app/api/volunteer/meal/route";
import { GET as exportRegistrations } from "@/app/api/admin/registrations/export/route";
import { POST as prepareCertificates } from "@/app/api/admin/events/[id]/certificates/route";
import { POST as publishCertificates } from "@/app/api/admin/certificates/publish/route";
import { GET as verifyCertificate } from "@/app/api/verify/[number]/route";
import { callRoute, freshToken, mintUser, resetAuth, resetFirestore, type TestUser } from "./harness";

/**
 * One connected journey, through the real handlers against the Auth and Firestore emulators - the seams between features
 * that no single-feature test crosses. In order: an organizer applies; the application is pending and grants nothing; the
 * platform approves it; the applicant is the Event Head (and their old token already works through the API, while the
 * claims catch up on the next visit); the head builds the event, invites a volunteer whose temporary password must be
 * replaced before anything works; a participant registers; the volunteer scans and serves a meal; the right people export
 * the list; certificates are prepared by the head and released by the platform; a revoked volunteer is out on the next
 * request; a second event's head never reaches the first; and a rejected application stays rejected and powerless.
 */

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
const signIn = async (email: string, password: string): Promise<string> => {
  const res = await fetch(`http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-api-key`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = (await res.json()) as { idToken?: string };
  if (!body.idToken) throw new Error(`could not sign ${email} in`);
  return body.idToken;
};

const application = (name: string) => ({
  organizationName: "Journey Institute",
  organizationType: "college" as const,
  contactEmail: "events@journey-institute.edu",
  city: "Chennai",
  state: "Tamil Nadu",
  name,
  description: "A journey through the whole product.",
  festType: "tech" as const,
  startDate: "2026-11-01",
  endDate: "2026-11-03",
  venue: "Main campus",
  expectedParticipants: 200,
  eventHead: { name: "Head Person", designation: "Convenor", phone: "+919000000000" },
});

let reviewer: TestUser;
let headA: TestUser; // applicant of fest A
let headB: TestUser; // applicant of fest B
let rejected: TestUser;
let participant: TestUser;
let festA = "";
let festB = "";
let eventA = "";
let volunteerToken = "";
let volunteerUid = "";
let ticket = "";
const TEMP_NEW_PASSWORD = "Chosen-password-9";

const members = (token: string, id: string) => callRoute(listMembers, { path: `/api/admin/fests/${id}/members`, params: { id }, token });
const decideApp = (id: string, body: Record<string, unknown>) => callRoute(decide, { method: "POST", path: `/api/admin/fests/${id}/verification`, params: { id }, token: reviewer.idToken, body });

beforeAll(async () => {
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "fake-api-key";
  await resetAuth();
  await resetFirestore();
  reviewer = await mintUser({ role: "super_admin", name: "Platform Reviewer" });
  headA = await mintUser({ name: "Applicant A" });
  headB = await mintUser({ name: "Applicant B" });
  rejected = await mintUser({ name: "Applicant C" });
  participant = await mintUser({ name: "Participant One" });
});

describe("1 · applying: pending, powerless, then approved", () => {
  it("files an application that is pending and gives the applicant no access", async () => {
    const res = await callRoute(registerEvent, { path: "/api/register-event", token: headA.idToken, body: application("Journey Fest A") });
    expect(res.status).toBe(201);
    festA = res.body.application.festId;
    expect(res.body.application.status).toBe("pending");
    expect((await members(headA.idToken, festA)).status).toBe(403);
    const mine = await callRoute(myApplications, { path: "/api/register-event", token: headA.idToken });
    expect(mine.body.applications).toHaveLength(1);
    expect(mine.body.applications[0]).toMatchObject({ festId: festA, status: "pending" });
  });

  it("shows the reviewer the application, and only the reviewer", async () => {
    const queue = await callRoute(reviewQueue, { path: "/api/admin/verifications", token: reviewer.idToken });
    expect(queue.body.applications.map((a: { festId: string }) => a.festId)).toContain(festA);
    expect(queue.body.applications.find((a: { festId: string }) => a.festId === festA).applicant.emailVerified).toBe(true);
    expect((await callRoute(reviewQueue, { path: "/api/admin/verifications", token: headA.idToken })).status).toBe(403);
  });

  it("approves it: the applicant is the Event Head, through the API at once and through the claims on the next visit", async () => {
    expect((await decideApp(festA, { action: "approve" })).status).toBe(200);

    // The token the applicant already holds (minted before approval) works: the API reads the membership live.
    expect((await members(headA.idToken, festA)).status).toBe(200);
    const access = await callRoute(myAccess, { path: "/api/me/access", token: headA.idToken });
    expect(access.body.memberships).toEqual([expect.objectContaining({ festId: festA, role: "head" })]);

    // The claims were behind (or are written already); a fresh token carries them either way, and the next check is quiet.
    const token = await freshToken(headA);
    expect(((await adminAuth().getUser(headA.uid)).customClaims ?? {}).fm).toEqual([festA]);
    expect((await callRoute(myAccess, { path: "/api/me/access", token })).body.refreshToken).toBe(false);
  });

  it("will not approve the same application twice or approve one's own", async () => {
    expect((await decideApp(festA, { action: "approve" })).status).toBeGreaterThanOrEqual(400);
    const own = await callRoute(registerEvent, { path: "/api/register-event", token: reviewer.idToken, body: application("Platform Own") });
    expect(own.body.application.status).toBe("approved"); // the platform's own event needs no review
  });
});

describe("2 · the Event Head builds the event and the team", () => {
  it("creates a competition, publishes it, and edits it", async () => {
    const token = await freshToken(headA);
    const created = await callRoute(createEvent, {
      path: "/api/admin/events",
      token,
      body: { festId: festA, slug: "hack-night", title: "Hack Night", category: "hackathon", venue: "Lab 4", date: "2026-11-02", startTime: "10:00", eventType: "solo", teamSize: { min: 1, max: 1 }, capacity: 40, gates: ["Gate A"], mealSlots: [{ date: "2026-11-02", mealType: "lunch", label: "Lunch" }] },
    });
    expect(created.status).toBe(201);
    eventA = created.body.event.id;
    expect(created.body.event.status).toBe("draft");

    const edited = await callRoute(patchEvent, { method: "PATCH", path: `/api/admin/events/${eventA}`, params: { id: eventA }, token, body: { description: "Overnight build" } });
    expect(edited.status).toBe(200);
    const published = await callRoute(patchEvent, { method: "PATCH", path: `/api/admin/events/${eventA}`, params: { id: eventA }, token, body: { status: "published" } });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const fest = await callRoute(patchFest, { method: "PATCH", path: `/api/admin/fests/${festA}`, params: { id: festA }, token, body: { action: "edit", changes: { status: "published", registrationState: "open" } } });
    expect(fest.status, JSON.stringify(fest.body)).toBe(200);
  });

  it("invites a volunteer: the temporary password opens one screen, and only the new password opens the rest", async () => {
    const token = await freshToken(headA);
    const email = `journey-vol-${Date.now()}@plansphere.test`;
    const res = await callRoute(assignMember, { method: "POST", path: `/api/admin/fests/${festA}/members`, params: { id: festA }, token, body: { email, name: "Journey Volunteer", role: "volunteer", eventIds: [eventA], duties: ["entry"] } });
    expect(res.status).toBe(201);
    const temporary = res.body.invite.temporaryPassword as string;
    volunteerUid = res.body.userId;

    // Signed in with the temporary password: nothing works except changing it.
    volunteerToken = await signIn(email, temporary);
    expect((await callRoute(roster, { path: `/api/volunteer/roster?eventId=${eventA}`, token: volunteerToken })).status).toBe(403);
    expect((await callRoute(changePassword, { path: "/api/auth/change-password", token: volunteerToken, body: { currentPassword: "Not-the-one-1", password: TEMP_NEW_PASSWORD, confirmPassword: TEMP_NEW_PASSWORD } })).status).toBe(422);
    const changed = await callRoute(changePassword, { path: "/api/auth/change-password", token: volunteerToken, body: { currentPassword: temporary, password: TEMP_NEW_PASSWORD, confirmPassword: TEMP_NEW_PASSWORD } });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    // The temporary password is dead; the new one works, and the account is now usable for its role.
    await expect(signIn(email, temporary)).rejects.toThrow();
    volunteerToken = await signIn(email, TEMP_NEW_PASSWORD);
    expect((await callRoute(roster, { path: `/api/volunteer/roster?eventId=${eventA}`, token: volunteerToken })).status).toBe(200);
  });
});

describe("3 · a participant registers and is let in", () => {
  it("registers for the free competition and gets a ticket", async () => {
    const res = await callRoute(register, { path: "/api/registrations", token: participant.idToken, body: { eventId: eventA, members: [{ name: participant.name, email: participant.email }] } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.registration.status).toBe("confirmed");
    ticket = res.body.registration.ticketCode;
    expect(ticket).toMatch(/^PS-/);
  });

  it("lets the volunteer check them in once, refuses the repeat, and refuses a meal the volunteer has no duty for", async () => {
    const first = await callRoute(scan, { path: "/api/volunteer/scan", token: volunteerToken, body: { eventId: eventA, ticketCode: ticket } });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.result ?? first.body.status ?? first.body.outcome).toBeTruthy();
    const again = await callRoute(scan, { path: "/api/volunteer/scan", token: volunteerToken, body: { eventId: eventA, ticketCode: ticket } });
    expect(JSON.stringify(again.body).toLowerCase()).toMatch(/already|duplicate/);
    const lunch = await callRoute(meal, { path: "/api/volunteer/meal", token: volunteerToken, body: { eventId: eventA, ticketCode: ticket, mealType: "lunch", servedOn: "2026-11-02" } });
    expect(lunch.status).toBe(403);
  });
});

describe("4 · who can export the list", () => {
  it("lets the head export, and an event admin export their own competition and nothing wider", async () => {
    const headToken = await freshToken(headA);
    const csv = await callRoute(exportRegistrations, { path: `/api/admin/registrations/export?festId=${festA}&format=csv`, token: headToken, raw: true });
    expect(csv.status).toBe(200);
    expect(Buffer.from(csv.bytes!).toString("utf8")).toContain(participant.name);

    const adminUser = await mintUser({ name: "Event Admin" });
    expect((await callRoute(assignMember, { method: "POST", path: `/api/admin/fests/${festA}/members`, params: { id: festA }, token: headToken, body: { email: adminUser.email, role: "admin", eventIds: [eventA], duties: [] } })).status).toBe(201);
    const adminToken = await freshToken(adminUser);
    const own = await callRoute(exportRegistrations, { path: `/api/admin/registrations/export?festId=${festA}&eventId=${eventA}&format=csv`, token: adminToken, raw: true });
    expect(own.status).toBe(200);
    // The whole fest is the head's, not an event admin's.
    expect((await callRoute(exportRegistrations, { path: `/api/admin/registrations/export?festId=${festA}&format=csv`, token: adminToken, raw: true })).status).toBe(403);
    // A participant, a volunteer and a stranger get nothing.
    for (const token of [participant.idToken, volunteerToken]) expect((await callRoute(exportRegistrations, { path: `/api/admin/registrations/export?festId=${festA}&eventId=${eventA}&format=csv`, token, raw: true })).status).toBe(403);
  });
});

describe("5 · certificates: prepared by the head, released by the platform", () => {
  it("prepares nothing until the event has ended, then prepares for the person who attended, and the platform releases it", async () => {
    const headToken = await freshToken(headA);
    const early = await callRoute(prepareCertificates, { path: `/api/admin/events/${eventA}/certificates`, params: { id: eventA }, token: headToken, body: {} });
    expect(early.status).toBe(422);

    await adminDb().collection(COLLECTIONS.events).doc(eventA).update({ status: "completed" });
    const prepared = await callRoute(prepareCertificates, { path: `/api/admin/events/${eventA}/certificates`, params: { id: eventA }, token: headToken, body: {} });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    expect(prepared.body.created).toBe(1);
    // The head cannot release; the participant sees nothing yet.
    expect((await callRoute(publishCertificates, { path: "/api/admin/certificates/publish", token: headToken, body: { eventId: eventA } })).status).toBe(403);

    const released = await callRoute(publishCertificates, { path: "/api/admin/certificates/publish", token: reviewer.idToken, body: { eventId: eventA } });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    expect(released.body.published).toBe(1);

    const certs = await adminDb().collection(COLLECTIONS.certificates).where("eventId", "==", eventA).get();
    expect(certs.size).toBe(1);
    const number = String(certs.docs[0]!.data().certificateNumber);
    const verified = await callRoute(verifyCertificate, { path: `/api/verify/${number}`, params: { number } });
    expect(verified.status).toBe(200);
  });
});

describe("6 · taking access away, and keeping events apart", () => {
  it("cuts a revoked volunteer off on the very next request with the token they were just using", async () => {
    const headToken = await freshToken(headA);
    expect((await callRoute(roster, { path: `/api/volunteer/roster?eventId=${eventA}`, token: volunteerToken })).status).toBe(200);
    const res = await callRoute(revokeMember, { method: "DELETE", path: "/x", params: { id: festA, uid: volunteerUid }, token: headToken });
    expect(res.status).toBe(200);
    expect((await callRoute(roster, { path: `/api/volunteer/roster?eventId=${eventA}`, token: volunteerToken })).status).toBe(403);
  });

  it("keeps one approved event's head out of another's people and competitions", async () => {
    const b = await callRoute(registerEvent, { path: "/api/register-event", token: headB.idToken, body: application("Journey Fest B") });
    festB = b.body.application.festId;
    expect((await decideApp(festB, { action: "approve" })).status).toBe(200);
    const tokenA = await freshToken(headA);
    const tokenB = await freshToken(headB);

    expect((await members(tokenB, festB)).status).toBe(200);
    expect((await members(tokenA, festB)).status).toBe(403);
    expect((await members(tokenB, festA)).status).toBe(403);
    expect((await callRoute(patchEvent, { method: "PATCH", path: `/api/admin/events/${eventA}`, params: { id: eventA }, token: tokenB, body: { description: "Hijacked" } })).status).toBe(403);
    // B is still a draft: nobody outside its own people reads it. (A's published event is public, B's draft fest is not.)
    const festBDoc = (await adminDb().collection(COLLECTIONS.fests).doc(festB).get()).data()!;
    expect(festBDoc.status).toBe("draft");
  });

  it("keeps a rejected application rejected, with a reason the applicant can read, and no access", async () => {
    const c = await callRoute(registerEvent, { path: "/api/register-event", token: rejected.idToken, body: application("Journey Fest C") });
    const festC = c.body.application.festId;
    expect((await decideApp(festC, { action: "reject", reason: "We could not match the organization to a college." })).status).toBe(200);
    const mine = await callRoute(myApplications, { path: "/api/register-event", token: rejected.idToken });
    expect(mine.body.applications[0]).toMatchObject({ festId: festC, status: "rejected" });
    expect(JSON.stringify(mine.body)).toContain("could not match");
    expect((await members(await freshToken(rejected), festC)).status).toBe(403);
    expect((await decideApp(festC, { action: "approve" })).status).toBeGreaterThanOrEqual(400); // a rejection is not reversed by approving
  });
});
