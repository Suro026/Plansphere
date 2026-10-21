import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDb, COLLECTIONS } from "@/server/firebase-admin";
import { repositories } from "@/data/repositories";
import { RepositoryError } from "@/core/models/common";
import { clientSignIn, clientSignOut, mintUser, resetAuth, resetFirestore, seedEvent, seedFest, type TestUser } from "./harness";

/**
 * The Firestore repository implementations, through the client SDK, signed
 * in as real emulator users so firestore.rules apply exactly as in the app.
 */

let student: TestUser;
let mate: TestUser;
let volunteer: TestUser;
const repos = repositories();

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
});
afterAll(() => clientSignOut());

beforeEach(async () => {
  await resetFirestore();
  await seedFest();
  await seedEvent();
  await seedEvent({ id: "ev-draft", slug: "secret", title: "Secret", status: "draft" });
  await seedFest({ id: "fest-draft", slug: "hidden", name: "Hidden", status: "draft" });
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

  it("reports slug availability to signed-in staff (the fest form)", async () => {
    await clientSignIn(volunteer);
    expect(await repos.fests.isSlugAvailable("bits2bytes")).toBe(false);
    expect(await repos.fests.isSlugAvailable("brand-new")).toBe(true);
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

    await clientSignIn(mate);
    const mates = await repos.registrations.listForUserWithEvents(mate.uid, mate.email);
    expect(mates.map((e) => e.registration.id).sort()).toEqual(["reg1", "reg2"]);
    const shared = mates.find((e) => e.registration.id === "reg1")!;
    expect(shared.attended).toBe(true); // the team's check-in is visible to the teammate
    expect(shared.registration.members.find((m) => m.email === mate.email)?.inviteStatus).toBe("pending");
  });

  it("existsForUserAndEvent works for the owner; getByTicketCode is a staff lookup", async () => {
    await seedRegistration("reg1");
    await clientSignIn(student);
    expect(await repos.registrations.existsForUserAndEvent(student.uid, "ev1")).toBe(true);
    expect(await repos.registrations.existsForUserAndEvent(student.uid, "ev-draft")).toBe(false);
    await expect(repos.registrations.getByTicketCode("FF-7K2M9QX4TB")).rejects.toBeInstanceOf(RepositoryError);
    await clientSignIn(volunteer);
    expect((await repos.registrations.getByTicketCode("FF-7K2M9QX4TB"))?.id).toBe("reg1");
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

describe("AttendanceRepository.recordScan (volunteer, online)", () => {
  it("checks a ticket in once, bumps the fest counter, then reports the duplicate", async () => {
    await seedRegistration("reg1");
    await clientSignIn(volunteer);

    const first = await repos.attendance.recordScan({ ticketCode: "FF-7K2M9QX4TB", eventId: "ev1", scannedBy: volunteer.uid, gate: "Gate A" });
    expect(first).toMatchObject({ result: "ok", registration: { id: "reg1", teamName: "Null Pointers", memberCount: 2 } });
    const fest = (await adminDb().collection(COLLECTIONS.fests).doc("fest1").get()).data()!;
    expect(fest.stats.checkIns).toBe(1);

    const second = await repos.attendance.recordScan({ ticketCode: "FF-7K2M9QX4TB", eventId: "ev1", scannedBy: volunteer.uid });
    expect(second.result).toBe("already-recorded");
    expect(await repos.attendance.countByEvent("ev1")).toBe(1);
    expect((await repos.attendance.attendedRegistrationIds("ev1")).has("reg1")).toBe(true);
  });

  it("refuses unknown codes, wrong events and cancelled entries", async () => {
    await seedRegistration("reg1");
    await seedRegistration("reg-x", { status: "cancelled", ticketCode: "FF-CANCELLED1" });
    await clientSignIn(volunteer);
    expect(await repos.attendance.recordScan({ ticketCode: "FF-NOTINROSTR", eventId: "ev1", scannedBy: volunteer.uid })).toEqual({ result: "not-found" });
    expect((await repos.attendance.recordScan({ ticketCode: "FF-7K2M9QX4TB", eventId: "ev-draft", scannedBy: volunteer.uid })).result).toBe("wrong-event");
    expect((await repos.attendance.recordScan({ ticketCode: "FF-CANCELLED1", eventId: "ev1", scannedBy: volunteer.uid })).result).toBe("cancelled");
  });

  it("refuses an entry whose payment is not verified, and admits it once it is", async () => {
    await seedRegistration("reg-unpaid", { status: "pending_payment", paymentStatus: "pending", ticketCode: "FF-UNPAYD0001" });
    await seedRegistration("reg-paid", { status: "confirmed", paymentStatus: "paid", ticketCode: "FF-PAYDTWK002" });
    await clientSignIn(volunteer);
    expect(await repos.attendance.recordScan({ ticketCode: "FF-UNPAYD0001", eventId: "ev1", scannedBy: volunteer.uid })).toEqual({ result: "unpaid" });
    expect((await repos.attendance.recordScan({ ticketCode: "FF-PAYDTWK002", eventId: "ev1", scannedBy: volunteer.uid })).result).toBe("ok");
    expect(await repos.attendance.countByEvent("ev1")).toBe(1);
  });

  it("refuses an incomplete (draft) team at the online gate", async () => {
    await seedRegistration("reg-draft", { status: "draft", ticketCode: "FF-DRAFTTEM01" });
    await seedRegistration("reg-draftpaid", { status: "draft", paymentStatus: "paid", ticketCode: "FF-DRAFTPYD01" });
    await clientSignIn(volunteer);
    expect(await repos.attendance.recordScan({ ticketCode: "FF-DRAFTTEM01", eventId: "ev1", scannedBy: volunteer.uid })).toEqual({ result: "draft" });
    expect(await repos.attendance.recordScan({ ticketCode: "FF-DRAFTPYD01", eventId: "ev1", scannedBy: volunteer.uid })).toEqual({ result: "draft" });
    expect(await repos.attendance.countByEvent("ev1")).toBe(0);
  });

  it("a student cannot record a scan", async () => {
    await seedRegistration("reg1");
    await clientSignIn(student);
    await expect(repos.attendance.recordScan({ ticketCode: "FF-7K2M9QX4TB", eventId: "ev1", scannedBy: student.uid })).rejects.toBeInstanceOf(RepositoryError);
  });
});
