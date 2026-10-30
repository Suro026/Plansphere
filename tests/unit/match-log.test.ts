import { describe, expect, it } from "vitest";
import { activeLog } from "@/core/models/match-log";
import type { MatchLogEntry } from "@/core/models/match-log";

const entry = (over: Partial<MatchLogEntry>): MatchLogEntry => ({
  id: "e1",
  matchId: "m1",
  festId: "f1",
  eventId: "ev1",
  type: "goal",
  label: "Goal",
  undone: false,
  at: new Date("2026-09-25T10:00:00Z"),
  createdBy: "vol1",
  ...over,
});

describe("activeLog", () => {
  it("drops undone entries", () => {
    const entries = [entry({ id: "e1" }), entry({ id: "e2", undone: true }), entry({ id: "e3" })];
    expect(activeLog(entries).map((e) => e.id)).toEqual(["e1", "e3"]);
  });

  it("orders by when the action happened, not array order", () => {
    const entries = [
      entry({ id: "late", at: new Date("2026-09-25T10:10:00Z") }),
      entry({ id: "early", at: new Date("2026-09-25T10:00:00Z") }),
      entry({ id: "middle", at: new Date("2026-09-25T10:05:00Z") }),
    ];
    expect(activeLog(entries).map((e) => e.id)).toEqual(["early", "middle", "late"]);
  });

  it("is empty for an empty log", () => {
    expect(activeLog([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const entries = [entry({ id: "b", at: new Date("2026-09-25T10:10:00Z") }), entry({ id: "a", at: new Date("2026-09-25T10:00:00Z") })];
    const before = entries.map((e) => e.id);
    activeLog(entries);
    expect(entries.map((e) => e.id)).toEqual(before);
  });
});
