import { describe, expect, it } from "vitest";
import {
  attendanceStats,
  capacityUtilization,
  certificateEventsOverTime,
  certificateStats,
  dailyRegistrations,
  eventWiseRegistrations,
  gateWiseScans,
  hourlyEntryTimeline,
  hourlyPeakRegistration,
  registrationsOverTime,
  seatHoldingRegistrations,
  teamVsIndividual,
  topNDistribution,
  volunteerLeaderboard,
  waitlistConversion,
} from "@/core/services/fest-analytics";
import { event, registration } from "./fixtures";

// Local wall-clock time (no "Z"), at noon so the UTC day-key used for
// bucketing can never disagree with the local calendar day at any
// real-world offset, and `getHours()` (local) matches the literal hour
// written here.
const day = (iso: string, hour = 12) => new Date(`${iso}T${String(hour).padStart(2, "0")}:00:00`);
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

describe("registrationsOverTime", () => {
  it("is empty for no registrations", () => {
    expect(registrationsOverTime([])).toEqual([]);
  });

  it("accumulates seats across days, one point per day", () => {
    const d1 = day("2026-09-01");
    const d3 = day("2026-09-03");
    const regs = [
      registration({ createdAt: d1, seats: 2 }),
      registration({ createdAt: day("2026-09-01", 14), seats: 1 }),
      registration({ createdAt: d3, seats: 3 }),
    ];
    const points = registrationsOverTime(regs);
    expect(points).toEqual([
      { label: dayKey(d1), value: 3 },
      { label: dayKey(day("2026-09-02")), value: 3 },
      { label: dayKey(d3), value: 6 },
    ]);
  });
});

describe("dailyRegistrations", () => {
  it("is not cumulative", () => {
    const d1 = day("2026-09-01");
    const d2 = day("2026-09-02");
    const regs = [registration({ createdAt: d1, seats: 2 }), registration({ createdAt: d2, seats: 5 })];
    expect(dailyRegistrations(regs)).toEqual([
      { label: dayKey(d1), value: 2 },
      { label: dayKey(d2), value: 5 },
    ]);
  });
});

describe("hourlyPeakRegistration", () => {
  it("buckets by hour of day across 24 cells", () => {
    const regs = [registration({ createdAt: day("2026-09-01", 9) }), registration({ createdAt: day("2026-09-02", 9) })];
    const cells = hourlyPeakRegistration(regs);
    expect(cells).toHaveLength(24);
    expect(cells[9]!.value).toBe(2);
    expect(cells[0]!.value).toBe(0);
  });
});

describe("teamVsIndividual", () => {
  it("splits by type", () => {
    expect(teamVsIndividual([{ type: "solo" }, { type: "team" }, { type: "team" }])).toEqual({ team: 2, individual: 1 });
  });
});

describe("eventWiseRegistrations", () => {
  it("sums seats per event, sorted descending", () => {
    const regs = [
      registration({ eventId: "a", eventTitle: "Alpha", seats: 1 }),
      registration({ eventId: "b", eventTitle: "Beta", seats: 5 }),
      registration({ eventId: "a", eventTitle: "Alpha", seats: 2 }),
    ];
    expect(eventWiseRegistrations(regs)).toEqual([
      { eventId: "b", eventTitle: "Beta", count: 5 },
      { eventId: "a", eventTitle: "Alpha", count: 3 },
    ]);
  });
});

describe("capacityUtilization", () => {
  it("omits uncapped events and sorts by fullest first", () => {
    const events = [
      event({ id: "1", title: "Full", capacity: 10, registeredCount: 10 }),
      event({ id: "2", title: "Half", capacity: 10, registeredCount: 5 }),
      event({ id: "3", title: "Uncapped", capacity: 0, registeredCount: 50 }),
    ];
    expect(capacityUtilization(events)).toEqual([
      { eventId: "1", title: "Full", capacity: 10, registered: 10, rate: 1 },
      { eventId: "2", title: "Half", capacity: 10, registered: 5, rate: 0.5 },
    ]);
  });
});

describe("topNDistribution", () => {
  it("groups the rest as others and counts blanks as Not stated", () => {
    const items = ["A", "A", "B", "", undefined, "C"];
    const dist = topNDistribution(items, (x) => x, 2);
    expect(dist.total).toBe(6);
    expect(dist.top).toEqual([
      { label: "A", count: 2 },
      { label: "Not stated", count: 2 },
    ]);
    expect(dist.others).toBe(2);
    expect(dist.otherGroups).toBe(2);
  });

  it("returns everything under the limit with no others", () => {
    const dist = topNDistribution(["A", "B"], (x) => x, 10);
    expect(dist.others).toBe(0);
    expect(dist.otherGroups).toBe(0);
  });
});

describe("attendanceStats", () => {
  it("computes checked-in, no-show and rate", () => {
    const stats = attendanceStats(["r1", "r2", "r3"], [{ registrationId: "r1" }, { registrationId: "r2" }]);
    expect(stats).toEqual({ registered: 3, checkedIn: 2, noShow: 1, attendanceRate: 2 / 3 });
  });

  it("is null-rate with no registrations rather than dividing by zero", () => {
    expect(attendanceStats([], []).attendanceRate).toBeNull();
  });
});

describe("waitlistConversion", () => {
  it("counts promoted vs still-waiting, ignoring cancelled", () => {
    const regs = [
      { status: "waitlisted" as const, promotedAt: undefined },
      { status: "confirmed" as const, promotedAt: day("2026-09-01") },
      { status: "cancelled" as const, promotedAt: undefined },
    ];
    expect(waitlistConversion(regs)).toEqual({ promoted: 1, stillWaiting: 1, total: 2, rate: 0.5 });
  });

  it("is null-rate when nobody has ever waitlisted", () => {
    expect(waitlistConversion([{ status: "confirmed" as const, promotedAt: undefined }]).rate).toBeNull();
  });
});

describe("hourlyEntryTimeline", () => {
  it("can restrict to a single calendar day", () => {
    const d1 = day("2026-09-01", 8);
    const d2 = day("2026-09-02", 8);
    const att = [{ scannedAt: d1 }, { scannedAt: d2 }];
    const cells = hourlyEntryTimeline(att, dayKey(d1));
    expect(cells[8]!.value).toBe(1);
  });
});

describe("gateWiseScans", () => {
  it("groups unspecified gates together", () => {
    expect(gateWiseScans([{ gate: "A" }, { gate: "A" }, { gate: undefined }])).toEqual([
      { gate: "A", count: 2 },
      { gate: "Unspecified", count: 1 },
    ]);
  });
});

describe("volunteerLeaderboard", () => {
  it("counts gate scans per member marked, and food scans per serving", () => {
    const attendance = [
      { members: [{ key: "k1", name: "A", email: "a@x.test", at: day("2026-09-01"), by: "v1" }, { key: "k2", name: "B", email: "b@x.test", at: day("2026-09-01"), by: "v2" }], scannedBy: "v1", scannedByName: "Vee One" },
      { members: [], scannedBy: "v1", scannedByName: "Vee One" },
    ];
    const meals = [{ collectedBy: "v2", collectedByName: "Vee Two" }, { collectedBy: "v2", collectedByName: "Vee Two" }];
    const board = volunteerLeaderboard(attendance, meals, [{ userId: "v1", userName: "Vee One", post: "Gate A" }]);
    const v1 = board.find((r) => r.userId === "v1")!;
    const v2 = board.find((r) => r.userId === "v2")!;
    expect(v1.gateScans).toBe(2);
    expect(v1.totalScans).toBe(2);
    expect(v1.posts).toEqual(["Gate A"]);
    expect(v2.gateScans).toBe(1);
    expect(v2.foodScans).toBe(2);
    expect(v2.totalScans).toBe(3);
  });
});

describe("certificateStats", () => {
  it("excludes revoked certificates and counts released via isReleased", () => {
    const certs = [
      { revoked: false, published: true, delivery: { status: "sent" as const, attempts: 1 } },
      { revoked: false, published: false, delivery: { status: "pending" as const, attempts: 0 } },
      { revoked: true, published: true, delivery: { status: "sent" as const, attempts: 1 } },
    ];
    const events = [{ type: "verify" as const }, { type: "verify" as const }, { type: "download" as const }];
    expect(certificateStats(certs, events)).toEqual({
      eligible: 2,
      released: 1,
      downloaded: 1,
      emailDelivered: 1,
      verificationCount: 2,
    });
  });
});

describe("certificateEventsOverTime", () => {
  it("buckets one event type per day", () => {
    const d1 = day("2026-09-01", 1);
    const d1b = day("2026-09-01", 2);
    const d2 = day("2026-09-02", 1);
    const events = [
      { type: "verify" as const, at: d1 },
      { type: "download" as const, at: d1b },
      { type: "verify" as const, at: d2 },
    ];
    expect(certificateEventsOverTime(events, "verify")).toEqual([
      { label: dayKey(d1), value: 1 },
      { label: dayKey(d2), value: 1 },
    ]);
  });
});

describe("seatHoldingRegistrations", () => {
  it("keeps confirmed and draft, drops waitlisted and cancelled", () => {
    const regs = [{ status: "confirmed" as const }, { status: "draft" as const }, { status: "waitlisted" as const }, { status: "cancelled" as const }];
    expect(seatHoldingRegistrations(regs)).toEqual([{ status: "confirmed" }, { status: "draft" }]);
  });
});
