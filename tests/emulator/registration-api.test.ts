import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { POST as register } from "@/app/api/registrations/route";
import { POST as cancel } from "@/app/api/registrations/[id]/cancel/route";
import { POST as team } from "@/app/api/registrations/[id]/team/route";
import { POST as staffAction } from "@/app/api/admin/registrations/[id]/route";
import { callRoute, eventDoc, festDoc, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * The registration transaction and the team workflow, against the real
 * route handlers and the Firestore emulator. These are the invariants that
 * make overbooking impossible: seats and counters move together, and two
 * people cannot both take the last seat.
 */

let a: TestUser;
let b: TestUser;
let c: TestUser;

beforeAll(async () => {
  await resetAuth();
  a = await mintUser({ name: "Alice" });
  b = await mintUser({ name: "Bob" });
  c = await mintUser({ name: "Chen" });
});

beforeEach(async () => {
  await resetFirestore();
  // users docs are wiped with Firestore; recreate the mirror rows.
  for (const u of [a, b, c]) {
    await adminDb().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, fullName: u.name, role: "student", emailVerified: true, student: { college: "T" }, createdAt: new Date(), updatedAt: new Date() });
  }
  await seedFest();
  await seedEvent();
});

const reg = (user: TestUser, body: Record<string, unknown>) => callRoute(register, { path: "/api/registrations", token: user.idToken, body: { eventId: "ev1", ...body } });
// A one-person team on the (team) event: the domain requires a team name
// whenever the event is a team event, however small the entry.
const solo = (user: TestUser) => reg(user, { teamName: `${user.name} solo`, members: [{ name: user.name, email: user.email }] });

describe("POST /api/registrations", () => {
  it("requires a signed-in, verified account with a profile", async () => {
    expect((await callRoute(register, { body: { eventId: "ev1", members: [] } })).status).toBe(401);
    const unverified = await mintUser({ emailVerified: false, name: "Unverified" });
    expect((await solo(unverified)).status).toBe(403);
    const noProfile = await mintUser({ profile: false, name: "Ghost" });
    expect((await solo(noProfile)).status).toBe(403);
  });

  it("grants a seat, bumps the counters, and writes the notification and email log", async () => {
    const res = await solo(a);
    expect(res.status).toBe(201);
    expect(res.body.registration).toMatchObject({ status: "confirmed", seats: 1, userId: a.uid, eventTitle: "Capture the Flag" });
    expect(res.body.registration.ticketCode).toMatch(/^PS-[0-9A-HJ-NP-Z]{10}$/);
    expect((await eventDoc()).registeredCount).toBe(1);
    expect((await festDoc()).stats.registrations).toBe(1);

    const notes = await adminDb().collection(COLLECTIONS.notifications).where("userId", "==", a.uid).get();
    expect(notes.docs.map((d) => d.data().type)).toEqual(["registration_confirmed"]);
    const log = await adminDb().collection(COLLECTIONS.emailLog).where("to", "==", a.email).get();
    expect(log.docs.map((d) => d.data().template)).toEqual(["registration_confirmed"]);
  });

  it("refuses a second active entry for the same person", async () => {
    expect((await solo(a)).status).toBe(201);
    const again = await solo(a);
    expect(again.status).toBe(409);
    expect((await eventDoc()).registeredCount).toBe(1);
  });

  it("gives exactly one of two simultaneous requests the last seat", async () => {
    await seedEvent({ capacity: 1 });
    const [r1, r2] = await Promise.all([solo(a), solo(b)]);
    const statuses = [r1.status, r2.status].sort();
    // One seat, one winner. The loser is told the event is full (422), or —
    // when the emulator gives up retrying the contended transaction rather
    // than replaying it — asked to try again (503). Never two seats.
    expect(statuses[0]).toBe(201);
    expect([422, 503]).toContain(statuses[1]);
    expect((await eventDoc()).registeredCount).toBe(1);
    const active = await adminDb().collection(COLLECTIONS.registrations).where("eventId", "==", "ev1").get();
    expect(active.size).toBe(1);
  });

  it("puts overflow on the waitlist when enabled, without consuming a seat", async () => {
    await seedEvent({ capacity: 1, waitlistEnabled: true });
    const firstRes = await solo(a);
    expect(firstRes.status, JSON.stringify(firstRes.body)).toBe(201);
    const wl = await solo(b);
    expect(wl.status).toBe(201);
    expect(wl.body.registration.status).toBe("waitlisted");
    expect((await eventDoc()).registeredCount).toBe(1);
  });

  it("promotes the earliest waitlisted entry when a confirmed one cancels", async () => {
    await seedEvent({ capacity: 1, waitlistEnabled: true });
    const first = await solo(a);
    const waiting = await solo(b);
    const res = await callRoute(cancel, { path: `/api/registrations/${first.body.registration.id}/cancel`, token: a.idToken, params: { id: first.body.registration.id }, body: {} });
    expect(res.status).toBe(200);
    expect(res.body.promoted).toBe(waiting.body.registration.id);
    const promoted = await adminDb().collection(COLLECTIONS.registrations).doc(waiting.body.registration.id).get();
    expect(promoted.data()!.status).toBe("confirmed");
    expect((await eventDoc()).registeredCount).toBe(1);
    const notes = await adminDb().collection(COLLECTIONS.notifications).where("userId", "==", b.uid).get();
    expect(notes.docs.map((d) => d.data().type)).toContain("waitlist_promoted");
    const log = await adminDb().collection(COLLECTIONS.emailLog).where("to", "==", b.email).where("template", "==", "waitlist_promoted").get();
    expect(log.size).toBe(1);
  });

  it("refuses a team larger than the free seats and validates team size", async () => {
    await seedEvent({ capacity: 2 });
    const tooBig = await reg(a, { teamName: "Trio", members: [{ name: "A", email: a.email }, { name: "B", email: b.email }, { name: "C", email: c.email }] });
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error).toMatch(/Only 2 seats left/);
    const tooMany = await reg(a, { teamName: "Quad", members: [{ name: "A", email: a.email }, { name: "B", email: b.email }, { name: "C", email: c.email }, { name: "D", email: "d@plansphere.test" }] });
    expect(tooMany.status).toBe(422);
    expect((await eventDoc()).registeredCount).toBe(0);
  });

  it("blocks a teammate who is already on another team for the event", async () => {
    expect((await solo(b)).status).toBe(201);
    const clash = await reg(a, { teamName: "Poach", members: [{ name: "A", email: a.email }, { name: "B", email: b.email }] });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toContain(b.email);
  });

  it("uses the verified identity for the leader whatever the body says", async () => {
    const res = await reg(a, { teamName: "Spoof", members: [{ name: "Mallory", email: "mallory@plansphere.test" }, { name: "Bob", email: b.email }] });
    expect(res.status).toBe(201);
    const leader = res.body.registration.members.find((m: { isLeader: boolean }) => m.isLeader);
    expect(leader).toMatchObject({ email: a.email, name: "Alice", userId: a.uid, inviteStatus: "accepted" });
    const mate = res.body.registration.members.find((m: { email: string }) => m.email === b.email);
    expect(mate).toMatchObject({ userId: b.uid, inviteStatus: "pending" });
  });
});

describe("POST /api/registrations/[id]/team", () => {
  let regId: string;
  const act = (user: TestUser, body: Record<string, unknown>) => callRoute(team, { path: `/api/registrations/${regId}/team`, token: user.idToken, params: { id: regId }, body });

  beforeEach(async () => {
    const res = await reg(a, { teamName: "Null Pointers", members: [{ name: "Alice", email: a.email }, { name: "Bob", email: b.email }] });
    regId = res.body.registration.id;
  });

  it("lets the invitee accept, and only the invitee", async () => {
    expect((await act(c, { action: "accept" })).status).toBe(403);
    const res = await act(b, { action: "accept" });
    expect(res.status).toBe(200);
    expect(res.body.registration.members.find((m: { email: string }) => m.email === b.email)).toMatchObject({ inviteStatus: "accepted", userId: b.uid });
    expect((await eventDoc()).registeredCount).toBe(2);
    const leaderNotes = await adminDb().collection(COLLECTIONS.notifications).where("userId", "==", a.uid).get();
    expect(leaderNotes.docs.map((d) => d.data().type)).toContain("team_update");
  });

  it("releases the seat when the invitee declines", async () => {
    const res = await act(b, { action: "decline" });
    expect(res.status).toBe(200);
    expect(res.body.registration.memberEmails).not.toContain(b.email);
    expect(res.body.registration.seats).toBe(1);
    expect((await eventDoc()).registeredCount).toBe(1);
    expect((await act(b, { action: "accept" })).status).toBe(403);
  });

  it("leader controls: invite takes a seat, remove gives it back, max and duplicates refused", async () => {
    expect((await act(b, { action: "invite", member: { name: "Chen", email: c.email } })).status).toBe(403);
    const invite = await act(a, { action: "invite", member: { name: "Chen", email: c.email } });
    expect(invite.status).toBe(200);
    expect(invite.body.registration.seats).toBe(3);
    expect((await eventDoc()).registeredCount).toBe(3);

    expect((await act(a, { action: "invite", member: { name: "Dee", email: "dee@plansphere.test" } })).status).toBe(422); // max 3
    expect((await act(a, { action: "invite", member: { name: "Chen", email: c.email } })).status).toBe(409);
    expect((await act(a, { action: "remove", email: a.email })).status).toBe(422); // leader

    const remove = await act(a, { action: "remove", email: c.email });
    expect(remove.status).toBe(200);
    expect(remove.body.registration.seats).toBe(2);
    expect((await eventDoc()).registeredCount).toBe(2);
  });

  it("refuses an invite when the event is full", async () => {
    await adminDb().collection(COLLECTIONS.events).doc("ev1").update({ capacity: 2 });
    const res = await act(a, { action: "invite", member: { name: "Chen", email: c.email } });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/full/);
  });

  it("freezes the roster once the pass has been scanned", async () => {
    await adminDb().collection(COLLECTIONS.attendance).doc(regId).set({ id: regId, registrationId: regId, eventId: "ev1", festId: "fest1", userId: a.uid, ticketCode: "FF-AAAAAAAAAA", scannedAt: new Date(), scannedBy: "vol", method: "qr", createdAt: new Date(), updatedAt: new Date() });
    expect((await act(a, { action: "invite", member: { name: "Chen", email: c.email } })).status).toBe(422);
    expect((await act(b, { action: "decline" })).status).toBe(422);
    expect((await act(a, { action: "rename", teamName: "Still allowed" })).status).toBe(200);
  });
});

describe("staff actions", () => {
  it("an admin can promote from the waitlist and cancel on the holder's behalf", async () => {
    await seedEvent({ capacity: 1, waitlistEnabled: true });
    const admin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Admin" });
    const first = await solo(a);
    const waiting = await solo(b);
    // Cancel the confirmed one, then promote the waitlisted one by hand.
    const cancelRes = await callRoute(staffAction, { path: `/api/admin/registrations/${first.body.registration.id}`, token: admin.idToken, params: { id: first.body.registration.id }, body: { action: "cancel", reason: "No-show" } });
    expect(cancelRes.status).toBe(200);
    // The cancellation promoted the waitlisted entry; the promoted person is told.
    const promoted = await adminDb().collection(COLLECTIONS.registrations).doc(waiting.body.registration.id).get();
    expect(promoted.data()!.status).toBe("confirmed");
    expect((await eventDoc()).registeredCount).toBe(1);
    const notes = await adminDb().collection(COLLECTIONS.notifications).where("userId", "==", b.uid).get();
    expect(notes.docs.map((d) => d.data().type)).toContain("waitlist_promoted");
    const cancelledNotes = await adminDb().collection(COLLECTIONS.notifications).where("userId", "==", a.uid).get();
    expect(cancelledNotes.docs.map((d) => d.data().type)).toContain("registration_cancelled");
    // Promoting an already-confirmed entry is refused, not silently accepted.
    const promoteRes = await callRoute(staffAction, { path: `/api/admin/registrations/${waiting.body.registration.id}`, token: admin.idToken, params: { id: waiting.body.registration.id }, body: { action: "promote" } });
    expect(promoteRes.status).toBe(422);
    const audit = await adminDb().collection(COLLECTIONS.auditLog).where("action", "==", "registration_cancelled_by_staff").get();
    expect(audit.size).toBe(1);

    const asStudent = await callRoute(staffAction, { path: `/api/admin/registrations/${waiting.body.registration.id}`, token: c.idToken, params: { id: waiting.body.registration.id }, body: { action: "cancel" } });
    expect(asStudent.status).toBe(403);
  });
});
