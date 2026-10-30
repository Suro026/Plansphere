import type { Event } from "@/core/models/event";
import type { Registration, TeamMember } from "@/core/models/registration";
import type { Result } from "@/core/models/result";

/** Deterministic byte source so generated codes are stable in assertions. */
export const seededBytes =
  (seed: number) =>
  (size: number): Uint8Array => {
    const out = new Uint8Array(size);
    let x = seed;
    for (let i = 0; i < size; i += 1) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      out[i] = x % 256;
    }
    return out;
  };

const now = new Date("2026-09-20T10:00:00Z");

export const event = (over: Partial<Event> = {}): Event => ({
  id: "ev1",
  festId: "fest1",
  slug: "ctf",
  title: "Capture the Flag",
  category: "technical",
  eventType: "team",
  teamSize: { min: 1, max: 3 },
  date: "2026-09-25",
  startTime: "10:00",
  venue: "Lab 4",
  capacity: 10,
  registeredCount: 0,
  waitlistEnabled: false,
  entryFee: 0,
  registrationOpen: true,
  status: "published",
  gates: [],
  mealSlots: [],
  coordinators: [],
  createdBy: "admin1",
  createdAt: now,
  updatedAt: now,
  ...over,
} as Event);

export const member = (over: Partial<TeamMember> & { email: string; name: string }): TeamMember => ({
  isLeader: false,
  inviteStatus: "accepted",
  ...over,
});

export const registration = (over: Partial<Registration> = {}): Registration => {
  const members = over.members ?? [member({ name: "Ishita Rao", email: "ishita@x.test", userId: "u1", isLeader: true })];
  return {
    id: "reg1",
    eventId: "ev1",
    festId: "fest1",
    userId: "u1",
    type: members.length > 1 ? "team" : "solo",
    members,
    memberEmails: members.map((m) => m.email.toLowerCase()),
    seats: members.length,
    ticketCode: "FF-7K2M9QX4TB",
    status: "confirmed",
    eventTitle: "Capture the Flag",
    userName: "Ishita Rao",
    userEmail: "ishita@x.test",
    createdAt: now,
    updatedAt: now,
    ...over,
  } as Registration;
};

export const publishedResult = (entries: Array<{ registrationId: string; position: number; displayName?: string }>): Result =>
  ({
    id: "ev1",
    eventId: "ev1",
    festId: "fest1",
    status: "published",
    entries: entries.map((e) => ({ registrationId: e.registrationId, position: e.position, displayName: e.displayName ?? e.registrationId, award: e.position === 1 ? "winner" : e.position === 2 ? "runner_up" : e.position === 3 ? "second_runner_up" : "special_mention" })),
    createdBy: "admin1",
    createdAt: now,
    updatedAt: now,
  }) as unknown as Result;
