import { describe, expect, it } from "vitest";
import { createRegistrationSchema, generateTicketCode, isTeammate, memberFor, teamActionSchema, teamShortfall, ticketCodeSchema, validateRegistration } from "@/core/models/registration";
import { isRegistrationOpen, seatsRemaining } from "@/core/models/event";
import { hasAtLeast } from "@/core/models/user";
import { event, member, registration, seededBytes } from "./fixtures";

describe("validateRegistration", () => {
  const solo = { eventType: "solo" as const, teamSize: { min: 1, max: 1 } };
  const team = { eventType: "team" as const, teamSize: { min: 2, max: 4 } };
  const m = (email: string) => ({ name: "X", email });

  it("rejects more than one member on a solo event", () => {
    expect(validateRegistration({ eventId: "e", members: [m("a@x.test"), m("b@x.test")] }, solo)).toMatchObject({ ok: false });
  });
  it("enforces team min and max", () => {
    expect(validateRegistration({ eventId: "e", teamName: "T", members: [m("a@x.test")] }, team)).toMatchObject({ ok: false, message: expect.stringContaining("at least 2") });
    // The server allows a short team through: it becomes a draft and
    // confirms when enough people accept or join with the code.
    expect(validateRegistration({ eventId: "e", teamName: "T", members: [m("a@x.test")] }, team, { allowIncomplete: true })).toEqual({ ok: true });
    // The maximum is never negotiable, incomplete or not.
    expect(
      validateRegistration({ eventId: "e", teamName: "T", members: ["a", "b", "c", "d", "e"].map((x) => m(`${x}@x.test`)) }, team, { allowIncomplete: true }),
    ).toMatchObject({ ok: false, message: expect.stringContaining("at most 4") });
    expect(validateRegistration({ eventId: "e", teamName: "T", members: ["a", "b", "c", "d", "e"].map((s) => m(`${s}@x.test`)) }, team)).toMatchObject({ ok: false, message: expect.stringContaining("at most 4") });
  });
  it("requires a team name for team events", () => {
    expect(validateRegistration({ eventId: "e", members: [m("a@x.test"), m("b@x.test")] }, team)).toMatchObject({ ok: false, message: "Enter a team name" });
  });
  it("rejects the same email twice regardless of case", () => {
    expect(validateRegistration({ eventId: "e", teamName: "T", members: [m("A@x.test"), m("a@X.test")] }, team)).toMatchObject({ ok: false, message: expect.stringContaining("twice") });
  });
  it("accepts a valid team", () => {
    expect(validateRegistration({ eventId: "e", teamName: "T", members: [m("a@x.test"), m("b@x.test")] }, team)).toEqual({ ok: true });
  });
});

describe("createRegistrationSchema", () => {
  it("does not let a client set userId, isLeader or inviteStatus on members", () => {
    const parsed = createRegistrationSchema.parse({
      eventId: "e1",
      teamName: "T",
      members: [{ name: "A", email: "a@x.test", userId: "hijack", isLeader: true, inviteStatus: "accepted" }],
    });
    expect(parsed.members[0]).toEqual({ name: "A", email: "a@x.test" });
  });
});

describe("ticket codes", () => {
  it("are PS- plus 10 characters from the Crockford alphabet (no I, L, O, U)", () => {
    for (let seed = 1; seed < 50; seed += 1) {
      const code = generateTicketCode(seededBytes(seed));
      expect(code).toMatch(/^PS-[0-9A-HJ-NP-Z]{10}$/);
      expect(code).not.toMatch(/[ILOU]/);
      expect(ticketCodeSchema.safeParse(code).success).toBe(true);
    }
  });
  it("are deterministic for a given byte source and different across sources", () => {
    expect(generateTicketCode(seededBytes(7))).toBe(generateTicketCode(seededBytes(7)));
    expect(generateTicketCode(seededBytes(7))).not.toBe(generateTicketCode(seededBytes(8)));
  });
  it("still accepts a code issued before the Plansphere rename", () => {
    expect(ticketCodeSchema.safeParse("FF-7K2M9QX4TB").success).toBe(true);
  });
  it("rejects lookalike characters and wrong lengths", () => {
    expect(ticketCodeSchema.safeParse("FF-7K2M9QX4TO").success).toBe(false);
    expect(ticketCodeSchema.safeParse("FF-7K2M9QX4T").success).toBe(false);
    expect(ticketCodeSchema.safeParse("ff-7k2m9qx4tb").success).toBe(false);
  });
});

describe("team helpers", () => {
  const reg = registration({
    teamName: "T",
    members: [member({ name: "L", email: "lead@x.test", userId: "u1", isLeader: true }), member({ name: "M", email: "Mate@x.test", inviteStatus: "pending" })],
  });
  it("memberFor is case-insensitive", () => {
    expect(memberFor(reg, "MATE@X.TEST")?.name).toBe("M");
    expect(memberFor(reg, "nobody@x.test")).toBeUndefined();
  });
  it("isTeammate excludes the leader and strangers", () => {
    expect(isTeammate(reg, "u9", "mate@x.test")).toBe(true);
    expect(isTeammate(reg, "u1", "lead@x.test")).toBe(false);
    expect(isTeammate(reg, "u9", "stranger@x.test")).toBe(false);
  });
  it("teamShortfall counts pending invitations and missing seats", () => {
    expect(teamShortfall(reg, { min: 3, max: 4 })).toEqual({ pending: 1, missing: 1 });
    expect(teamShortfall(reg, { min: 1, max: 4 })).toEqual({ pending: 1, missing: 0 });
  });
  it("teamActionSchema accepts every action and rejects unknown ones", () => {
    expect(teamActionSchema.safeParse({ action: "invite", member: { name: "N", email: "n@x.test" } }).success).toBe(true);
    expect(teamActionSchema.safeParse({ action: "remove", email: "n@x.test" }).success).toBe(true);
    expect(teamActionSchema.safeParse({ action: "rename", teamName: "New" }).success).toBe(true);
    expect(teamActionSchema.safeParse({ action: "accept" }).success).toBe(true);
    expect(teamActionSchema.safeParse({ action: "decline" }).success).toBe(true);
    expect(teamActionSchema.safeParse({ action: "transfer", email: "n@x.test" }).success).toBe(false);
    expect(teamActionSchema.safeParse({ action: "invite", member: { name: "N", email: "not-an-email" } }).success).toBe(false);
  });
});

describe("isRegistrationOpen / seatsRemaining", () => {
  const at = new Date("2026-09-20T12:00:00");
  it("closes when full, closed, unpublished, or past the deadline", () => {
    expect(isRegistrationOpen(event(), at)).toBe(true);
    expect(isRegistrationOpen(event({ registeredCount: 10 }), at)).toBe(false);
    expect(isRegistrationOpen(event({ registrationOpen: false }), at)).toBe(false);
    expect(isRegistrationOpen(event({ status: "draft" }), at)).toBe(false);
    expect(isRegistrationOpen(event({ status: "completed" }), at)).toBe(false);
    expect(isRegistrationOpen(event({ registrationDeadline: "2026-09-19" }), at)).toBe(false);
  });
  it("stays open through the whole deadline day and with unlimited capacity", () => {
    expect(isRegistrationOpen(event({ registrationDeadline: "2026-09-20" }), at)).toBe(true);
    expect(isRegistrationOpen(event({ capacity: 0, registeredCount: 9999 }), at)).toBe(true);
    expect(seatsRemaining(event({ capacity: 0 }))).toBeNull();
    expect(seatsRemaining(event({ capacity: 10, registeredCount: 7 }))).toBe(3);
    expect(seatsRemaining(event({ capacity: 10, registeredCount: 12 }))).toBe(0);
  });
});

describe("hasAtLeast", () => {
  it("orders student < volunteer < admin < super_admin", () => {
    expect(hasAtLeast("student", "volunteer")).toBe(false);
    expect(hasAtLeast("volunteer", "volunteer")).toBe(true);
    expect(hasAtLeast("admin", "volunteer")).toBe(true);
    expect(hasAtLeast("super_admin", "admin")).toBe(true);
    expect(hasAtLeast("admin", "super_admin")).toBe(false);
    expect(hasAtLeast(undefined, "student")).toBe(false);
  });
});
