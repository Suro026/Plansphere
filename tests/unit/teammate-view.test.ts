import { describe, expect, it } from "vitest";
import { maskEmail, registrationFor, registrationSchema, teammateView, type RegistrationWire } from "@/core/models/registration";

/**
 * What a teammate may see of a team entry. The leader types every member's contact details into the entry so the
 * organiser can run the event; the other members get the shared ticket, not that data.
 */

const SECRETS = ["lead.person@college.edu", "mate.person@college.edu", "third.person@college.edu", "+919800000001", "+919800000002", "ROLL-LEAD-1", "ROLL-THIRD-3", "Leader College", "PRIVATE-ANSWER", "JOIN42"];

const entry = (): RegistrationWire => ({
  id: "reg1",
  eventId: "ev1",
  festId: "fest1",
  userId: "uid-lead",
  type: "team",
  teamName: "Null Pointers",
  members: [
    { name: "Lead Person", email: "lead.person@college.edu", phone: "+919800000001", studentId: "ROLL-LEAD-1", college: "Leader College", userId: "uid-lead", isLeader: true, inviteStatus: "accepted" },
    { name: "Mate Person", email: "mate.person@college.edu", phone: "+919800000002", userId: "uid-mate", isLeader: false, inviteStatus: "pending", invitedAt: "2026-09-01T10:00:00.000Z" },
    { name: "Third Person", email: "third.person@college.edu", studentId: "ROLL-THIRD-3", isLeader: false, inviteStatus: "accepted", respondedAt: "2026-09-02T10:00:00.000Z" },
  ],
  memberEmails: ["lead.person@college.edu", "mate.person@college.edu", "third.person@college.edu"],
  seats: 3,
  ticketCode: "PS-ABCDEFGHJK",
  joinCode: "JOIN42",
  status: "confirmed",
  paymentStatus: "not_required",
  eventTitle: "Capture the Flag",
  userName: "Lead Person",
  userEmail: "lead.person@college.edu",
  answers: { phone: "+919800000001", note: "PRIVATE-ANSWER" },
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:00.000Z",
});

describe("maskEmail", () => {
  it("keeps the first letter and the domain, hides the rest, and is still a valid address", () => {
    expect(maskEmail("lead.person@college.edu")).toBe("l___@college.edu");
    expect(maskEmail("a@b.co")).toBe("a___@b.co");
    expect(maskEmail("weird")).toBe("hidden@hidden.invalid");
    expect(maskEmail("@nolocal.com")).toBe("hidden@hidden.invalid");
  });
});

describe("teammateView", () => {
  const view = teammateView(entry(), "Mate.Person@College.edu");

  it("never contains another member's email, phone, ID or college, the leader's answers or the join code", () => {
    const text = JSON.stringify(view);
    // The viewer's own row is their own data; everything else must be gone.
    const others = SECRETS.filter((s) => s !== "mate.person@college.edu" && s !== "+919800000002");
    for (const secret of others) expect(text, secret).not.toContain(secret);
  });

  it("keeps what a teammate needs: the shared ticket, the team, who is on it and who has accepted", () => {
    expect(view).toMatchObject({ id: "reg1", ticketCode: "PS-ABCDEFGHJK", teamName: "Null Pointers", status: "confirmed", eventTitle: "Capture the Flag", userName: "Lead Person", userId: "uid-lead", seats: 3 });
    expect(view.members.map((m) => [m.name, m.inviteStatus, m.isLeader])).toEqual([
      ["Lead Person", "accepted", true],
      ["Mate Person", "pending", false],
      ["Third Person", "accepted", false],
    ]);
    expect(view.members[2]).toMatchObject({ respondedAt: "2026-09-02T10:00:00.000Z" });
  });

  it("leaves the viewer's own row whole, whatever case their address is in, and masks the rest", () => {
    expect(view.members[1]).toMatchObject({ email: "mate.person@college.edu", phone: "+919800000002", userId: "uid-mate" });
    expect(view.members[0]).toEqual({ name: "Lead Person", email: "l___@college.edu", isLeader: true, userId: "uid-lead", inviteStatus: "accepted", invitedAt: undefined, respondedAt: undefined });
    // A member without an account stays without one, so the team page can still say "No account yet".
    expect(view.members[2]?.userId).toBeUndefined();
    expect(view.members[2]?.email).toBe("t___@college.edu");
    expect(view.userEmail).toBe("l___@college.edu");
    expect(view.memberEmails).toEqual(["mate.person@college.edu"]);
    expect(view.answers).toEqual({});
    expect(view).not.toHaveProperty("joinCode");
  });

  it("still parses as a registration, so the app can show it unchanged", () => {
    const parsed = registrationSchema.safeParse(view);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });

  it("does not claim a membership the viewer no longer has (for example straight after declining)", () => {
    const left = entry();
    left.members = left.members.filter((m) => m.email !== "mate.person@college.edu");
    left.memberEmails = left.memberEmails!.filter((e) => e !== "mate.person@college.edu");
    const after = teammateView(left, "mate.person@college.edu");
    expect(after.memberEmails).toEqual([]);
    expect(JSON.stringify(after)).not.toContain("lead.person@college.edu");
  });

  it("does not modify the entry it was given", () => {
    const original = entry();
    teammateView(original, "mate.person@college.edu");
    expect(original).toEqual(entry());
  });
});

describe("registrationFor", () => {
  it("gives the person who made the entry everything, and anyone else the teammate view", () => {
    const full = registrationFor(entry(), { uid: "uid-lead", email: "lead.person@college.edu" });
    expect(full).toEqual(entry());
    expect(full.members[1]?.email).toBe("mate.person@college.edu");
    expect(full.joinCode).toBe("JOIN42");

    const mate = registrationFor(entry(), { uid: "uid-mate", email: "mate.person@college.edu" });
    expect(mate.members[0]?.email).toBe("l___@college.edu");
    expect(mate).not.toHaveProperty("joinCode");
  });

  it("is not fooled by a matching email on someone else's account: ownership is by uid", () => {
    // A different uid claiming the leader's address is still a teammate-level viewer of an entry it does not own.
    const impostor = registrationFor(entry(), { uid: "uid-other", email: "lead.person@college.edu" });
    expect(impostor.joinCode).toBeUndefined();
    expect(impostor.answers).toEqual({});
  });
});
