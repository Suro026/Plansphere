import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { repositories } from "@/data/repositories";
import { RepositoryError } from "@/core/models/common";
import { GET as myTeamEntries } from "@/app/api/registrations/mine/route";
import { GET as gateRoster } from "@/app/api/volunteer/roster/route";
import { POST as gateScan } from "@/app/api/volunteer/scan/route";
import { POST as gateMeal } from "@/app/api/volunteer/meal/route";
import { clientSignIn, clientSignOut, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * The Firestore repository implementations, through the client SDK, signed
 * in as real emulator users so firestore.rules apply exactly as in the app.
 */

let student: TestUser;
let mate: TestUser;
let volunteer: TestUser;
let otherVolunteer: TestUser;
let superAdmin: TestUser;
let fest1Admin: TestUser;
const repos = repositories();
const realFetch = globalThis.fetch;

const seedRegistration = async (id: string, over: Record<string, unknown> = {}) => {
  const now = new Date();
  await adminDb()
    .collection(COLLECTIONS.registrations)
    .doc(id)
    .set({
      id,
      eventId: "ev1",
      festId: "fest1",
      userId: student.uid,
      type: "team",
      teamName: "Null Pointers",
      members: [
        { name: student.name, email: student.email, userId: student.uid, isLeader: true, inviteStatus: "accepted" },
        { name: mate.name, email: mate.email, userId: mate.uid, isLeader: false, inviteStatus: "pending" },
      ],
      memberEmails: [student.email, mate.email],
      seats: 2,
      ticketCode: "FF-7K2M9QX4TB",
      status: "confirmed",
      eventTitle: "Capture the Flag",
      userName: student.name,
      userEmail: student.email,
      createdAt: now,
      updatedAt: now,
      ...over,
    });
};

beforeAll(async () => {
  await resetAuth();
  student = await mintUser({ name: "Student One" });
  mate = await mintUser({ name: "Student Two" });
  volunteer = await mintUser({ role: "volunteer", festIds: ["fest1"], name: "Vol" });
  otherVolunteer = await mintUser({ role: "volunteer", festIds: ["fest2"], name: "Other Vol" });
  superAdmin = await mintUser({ role: "super_admin", name: "Platform Owner" });
  fest1Admin = await mintUser({ role: "admin", festIds: ["fest1"], name: "Fest One Admin" });
  // The repositories call the app's own API for a teammate's view of an entry; there is no Next server here, so the
  // real route handler answers.
  const handlers: Record<string, (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>> = {
    "/api/registrations/mine": myTeamEntries,
    "/api/volunteer/roster": gateRoster,
    "/api/volunteer/scan": gateScan,
    "/api/volunteer/meal": gateMeal,
  };
  vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const handler = handlers[path.split("?")[0] ?? ""];
    return handler
      ? handler(new Request(`http://localhost:3000${path}`, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body }), { params: Promise.resolve({}) })
      : realFetch(input, init);
  }) as typeof fetch);
});
afterAll(() => {
  vi.unstubAllGlobals();
  return clientSignOut();
});

beforeEach(async () => {
  await resetFirestore();
  await seedFest();
  await seedEvent();
  await seedEvent({ id: "ev-draft", slug: "secret", title: "Secret", status: "draft" });
  await seedFest({ id: "fest-draft", slug: "hidden", name: "Hidden", status: "draft" });
  // The server routes the gate calls resolve the caller from their profile, which resetFirestore() just wiped.
  const profiles: Array<[TestUser, string, string[]]> = [[student, "student", []], [mate, "student", []], [volunteer, "volunteer", ["fest1"]], [otherVolunteer, "volunteer", ["fest2"]], [superAdmin, "super_admin", []], [fest1Admin, "admin", ["fest1"]]];
  for (const [u, role, festIds] of profiles) {
    await adminDb().collection(COLLECTIONS.users).doc(u.uid).set({ id: u.uid, email: u.email, name: u.name, role, festIds, profileCompleted: true, mustChangePassword: false, createdAt: new Date(), updatedAt: new Date() });
  }
  await clientSignOut();
});

describe("FestRepository / EventRepository (public reads)", () => {
  it("resolves published fests and events by slug, and hides drafts", async () => {
    const fest = await repos.fests.getBySlug("bits2bytes");
    expect(fest?.name).toBe("Bits2Bytes");
    expect(await repos.fests.getBySlug("hidden")).toBeNull();
    const published = await repos.fests.listPublished();
    expect(published.map((f) => f.slug)).toEqual(["bits2bytes"]);

    const event = await repos.events.getBySlug("fest1", "CTF");
    expect(event?.title).toBe("Capture the Flag");
    expect(await repos.events.getBySlug("fest1", "secret")).toBeNull();
  });

  it("lets only the platform enumerate fests: slug counts and unfiltered lists are refused to other staff", async () => {
    // A count over fests reads every fest, and so would also read the applications still under review. Fests are created
    // on the server now, which checks the address itself; the client-side check is for the platform alone.
    await clientSignIn(volunteer);
    await expect(repos.fests.isSlugAvailable("bits2bytes")).rejects.toBeInstanceOf(RepositoryError);
    await expect(repos.fests.list({ limit: 200 })).rejects.toBeInstanceOf(RepositoryError);

    await clientSignIn(superAdmin);
    expect(await repos.fests.isSlugAvailable("bits2bytes")).toBe(false);
    expect(await repos.fests.isSlugAvailable("brand-new")).toBe(true);
    expect((await repos.fests.list({ limit: 200 })).items.map((f) => f.id).sort()).toEqual(["fest-draft", "fest1"]);
  });

  it("lists a staff member's own fests one by one, leaves out any that is missing or not theirs to read, and never an unrelated application", async () => {
    await seedFest({ id: "fest-pending", slug: "pending-app", name: "Pending Application", status: "draft", verification: { status: "pending", submittedAt: new Date() } });
    await clientSignIn(volunteer); // assigned to fest1 only

    // Their own fest, a fest id that no longer exists, and somebody else's pending application.
    const own = await repos.fests.list({ festIds: ["fest1", "deleted-fest", "fest-pending"], limit: 200 });
    expect(own.items.map((f) => f.id)).toEqual(["fest1"]);

    // A staff member of the pending application's fest does see it.
    const manager = await mintUser({ role: "admin", festIds: ["fest-pending"], name: "Application Manager" });
    await clientSignIn(manager);
    expect((await repos.fests.list({ festIds: ["fest-pending"], limit: 200 })).items.map((f) => f.id)).toEqual(["fest-pending"]);
  });
});

describe("RegistrationRepository.listForUserWithEvents", () => {
  it("returns entries the student created and team entries that name them, joined with events and attendance", async () => {
    await seedRegistration("reg1");
    await seedRegistration("reg2", { userId: mate.uid, userName: mate.name, userEmail: mate.email, teamName: "Mate's", members: [{ name: mate.name, email: mate.email, userId: mate.uid, isLeader: true, inviteStatus: "accepted" }], memberEmails: [mate.email], seats: 1, ticketCode: "FF-AAAAAAAAAA" });
    await adminDb().collection(COLLECTIONS.attendance).doc("reg1").set({ id: "reg1", registrationId: "reg1", eventId: "ev1", festId: "fest1", userId: student.uid, userName: student.name, userEmail: student.email, ticketCode: "FF-7K2M9QX4TB", scannedAt: new Date(), scannedBy: volunteer.uid, method: "qr", createdAt: new Date(), updatedAt: new Date() });

    await clientSignIn(student);
    const own = await repos.registrations.listForUserWithEvents(student.uid, student.email);
    expect(own.map((e) => e.registration.id)).toEqual(["reg1"]);
    expect(own[0]?.attended, JSON.stringify(own[0])).toBe(true);
    expect(own[0]?.event).toMatchObject({ title: "Capture the Flag", venue: "Lab 4" });

    // The API authenticates against the user's profile document (a missing or disabled profile is refused), so give
    // the teammate one, as every real account has.
    await adminDb().collection(COLLECTIONS.users).doc(mate.uid).set({ id: mate.uid, email: mate.email, name: mate.name, role: "student", festIds: [], disabled: false, mustChangePassword: false, createdAt: new Date(), updatedAt: new Date() });
    await clientSignIn(mate);
    const mates = await repos.registrations.listForUserWithEvents(mate.uid, mate.email);
    expect(mates.map((e) => e.registration.id).sort()).toEqual(["reg1", "reg2"]);
    const shared = mates.find((e) => e.registration.id === "reg1")!;
    expect(shared.attended).toBe(true); // the team's check-in is visible to the teammate
    expect(shared.registration.members.find((m) => m.email === mate.email)?.inviteStatus).toBe("pending");
    // The teammate's copy is served by /api/registrations/mine, which strips the other members' contact details.
    expect(shared.registration.members.find((m) => m.isLeader)?.email).not.toBe(student.email);
    expect(JSON.stringify(shared.registration)).not.toContain(student.email);
  });

  it("existsForUserAndEvent works for the owner; getByTicketCode is an admin lookup, and a volunteer's is refused", async () => {
    await seedRegistration("reg1");
    await clientSignIn(student);
    expect(await repos.registrations.existsForUserAndEvent(student.uid, "ev1")).toBe(true);
    expect(await repos.registrations.existsForUserAndEvent(student.uid, "ev-draft")).toBe(false);
    await expect(repos.registrations.getByTicketCode("FF-7K2M9QX4TB", "fest1")).rejects.toBeInstanceOf(RepositoryError);
    // A volunteer reads no registration: the gate asks the server, which answers with the minimum.
    await clientSignIn(volunteer);
    await expect(repos.registrations.getByTicketCode("FF-7K2M9QX4TB", "fest1")).rejects.toBeInstanceOf(RepositoryError);
    await clientSignIn(fest1Admin);
    expect((await repos.registrations.getByTicketCode("FF-7K2M9QX4TB", "fest1"))?.id).toBe("reg1");
    // A lookup that does not name the admin's fest cannot be proved to stay inside it, so it is refused.
    await expect(repos.registrations.getByTicketCode("FF-7K2M9QX4TB")).rejects.toBeInstanceOf(RepositoryError);
    await expect(repos.registrations.getByTicketCode("FF-7K2M9QX4TB", "fest2")).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe("NotificationRepository", () => {
  it("lists newest first, counts unread, marks one and then all read", async () => {
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await adminDb().collection(COLLECTIONS.notifications).add({ userId: student.uid, type: "announcement", title: `N${i}`, body: "", read: false, createdAt: new Date(now - i * 60_000), updatedAt: new Date(now - i * 60_000) });
    }
    await adminDb().collection(COLLECTIONS.notifications).add({ userId: mate.uid, type: "announcement", title: "Not mine", body: "", read: false, createdAt: new Date(), updatedAt: new Date() });

    await clientSignIn(student);
    const list = await repos.notifications.listForUser(student.uid);
    expect(list.map((n) => n.title)).toEqual(["N0", "N1", "N2"]);
    expect(await repos.notifications.unreadCount(student.uid)).toBe(3);

    await repos.notifications.markRead(list[0]!.id);
    expect(await repos.notifications.unreadCount(student.uid)).toBe(2);
    expect(await repos.notifications.markAllRead(student.uid)).toBe(2);
    expect(await repos.notifications.unreadCount(student.uid)).toBe(0);

    // The other user's notification is untouched and unreadable.
    const theirs = await adminDb().collection(COLLECTIONS.notifications).where("userId", "==", mate.uid).get();
    expect(theirs.docs[0]!.data().read).toBe(false);
    await expect(repos.notifications.markRead(theirs.docs[0]!.id)).rejects.toBeInstanceOf(RepositoryError);
  });
});

describe("AttendanceRepository.recordScan — a volunteer cannot look up another fest's tickets", () => {
  it("a ticket from a fest the volunteer does not work at is never revealed", async () => {
    await seedRegistration("reg1");
    await clientSignIn(otherVolunteer);
    // The server decides the fest from the competition, not from anything the phone says: scanning a competition of
    // someone else's fest is refused outright, whatever fest the request names.
    await expect(repos.attendance.recordScan({ ticketCode: "FF-7K2M9QX4TB", eventId: "ev1", festId: "fest2", scannedBy: otherVolunteer.uid })).rejects.toBeInstanceOf(RepositoryError);
    await expect(repos.attendance.recordScan({ ticketCode: "FF-7K2M9QX4TB", eventId: "ev1", festId: "fest1", scannedBy: otherVolunteer.uid })).rejects.toBeInstanceOf(RepositoryError);
    // The full roster is no volunteer's to read, in anyone's fest.
    await expect(repos.registrations.listForEvent("ev1", "fest1")).rejects.toBeInstanceOf(RepositoryError);
    await expect(repos.registrations.listForEvent("ev1", "fest2")).rejects.toBeInstanceOf(RepositoryError);
    expect(await attendanceCount()).toBe(0);
  });
});

/** What was actually recorded, read with admin credentials - a volunteer cannot list check-ins. */
const attendanceCount = async () => (await adminDb().collection(COLLECTIONS.attendance).where("eventId", "==", "ev1").get()).size;

describe("AttendanceRepository.recordScan (volunteer, online)", () => {
  it("checks a ticket in once, bumps the fest counter, then reports the duplicate", async () => {
    await seedRegistration("reg1");
    await clientSignIn(volunteer);

    const first = await repos.attendance.recordScan({ ticketCode: "FF-7K2M9QX4TB", eventId: "ev1", festId: "fest1", scannedBy: volunteer.uid, gate: "Gate A" });
    expect(first).toMatchObject({ result: "ok", registration: { id: "reg1", teamName: "Null Pointers", memberCount: 2 } });
    const fest = (await adminDb().collection(COLLECTIONS.fests).doc("fest1").get()).data()!;
    expect(fest.stats.checkIns).toBe(1);

    const second = await repos.attendance.recordScan({ ticketCode: "FF-7K2M9QX4TB", eventId: "ev1", festId: "fest1", scannedBy: volunteer.uid });
    expect(second.result).toBe("already-recorded");
    expect(await attendanceCount()).toBe(1);
    expect((await adminDb().collection(COLLECTIONS.attendance).doc("reg1").get()).exists).toBe(true);
    // The people on the entry come back with a masked address, never the real one.
    const members = (second as { members?: Array<{ email: string }> }).members ?? [];
    expect(members.length).toBe(2);
    for (const member of members) expect(member.email).not.toContain(student.email);
  });

  it("refuses unknown codes, wrong events and cancelled entries", async () => {
    await seedRegistration("reg1");
    await seedRegistration("reg-x", { status: "cancelled", ticketCode: "FF-CANCELLED1" });
    await clientSignIn(volunteer);
    expect(await repos.attendance.recordScan({ ticketCode: "FF-NOTINROSTR", eventId: "ev1", festId: "fest1", scannedBy: volunteer.uid })).toEqual({ result: "not-found" });
    expect((await repos.attendance.recordScan({ ticketCode: "FF-7K2M9QX4TB", eventId: "ev-draft", festId: "fest1", scannedBy: volunteer.uid })).result).toBe("wrong-event");
    expect((await repos.attendance.recordScan({ ticketCode: "FF-CANCELLED1", eventId: "ev1", festId: "fest1", scannedBy: volunteer.uid })).result).toBe("cancelled");
  });

  it("refuses an entry whose payment is not verified, and admits it once it is", async () => {
    await seedRegistration("reg-unpaid", { status: "pending_payment", paymentStatus: "pending", ticketCode: "FF-UNPAYD0001" });
    await seedRegistration("reg-paid", { status: "confirmed", paymentStatus: "paid", ticketCode: "FF-PAYDTWK002" });
    await clientSignIn(volunteer);
    expect(await repos.attendance.recordScan({ ticketCode: "FF-UNPAYD0001", eventId: "ev1", festId: "fest1", scannedBy: volunteer.uid })).toEqual({ result: "unpaid" });
    expect((await repos.attendance.recordScan({ ticketCode: "FF-PAYDTWK002", eventId: "ev1", festId: "fest1", scannedBy: volunteer.uid })).result).toBe("ok");
    expect(await attendanceCount()).toBe(1);
  });

  it("refuses an incomplete (draft) team at the online gate", async () => {
    await seedRegistration("reg-draft", { status: "draft", ticketCode: "FF-DRAFTTEM01" });
    await seedRegistration("reg-draftpaid", { status: "draft", paymentStatus: "paid", ticketCode: "FF-DRAFTPYD01" });
    await clientSignIn(volunteer);
    expect(await repos.attendance.recordScan({ ticketCode: "FF-DRAFTTEM01", eventId: "ev1", festId: "fest1", scannedBy: volunteer.uid })).toEqual({ result: "draft" });
    expect(await repos.attendance.recordScan({ ticketCode: "FF-DRAFTPYD01", eventId: "ev1", festId: "fest1", scannedBy: volunteer.uid })).toEqual({ result: "draft" });
    expect(await attendanceCount()).toBe(0);
  });

  it("a student cannot record a scan", async () => {
    await seedRegistration("reg1");
    await clientSignIn(student);
    await expect(repos.attendance.recordScan({ ticketCode: "FF-7K2M9QX4TB", eventId: "ev1", festId: "fest1", scannedBy: student.uid })).rejects.toBeInstanceOf(RepositoryError);
  });
});
