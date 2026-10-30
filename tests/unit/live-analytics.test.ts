import { describe, expect, it } from "vitest";
import { arenaUtilization, matchStats, mostActiveVolunteers, teamWinRate } from "@/core/services/live-analytics";

describe("matchStats", () => {
  it("counts matches by status", () => {
    const matches = [{ status: "live" as const }, { status: "upcoming" as const }, { status: "completed" as const }, { status: "completed" as const }, { status: "cancelled" as const }];
    expect(matchStats(matches)).toMatchObject({ total: 5, live: 1, upcoming: 1, completed: 2, cancelled: 1 });
  });

  it("averages duration only across matches with both a start and a finish", () => {
    const matches = [
      { status: "completed" as const, startedAt: new Date("2026-09-25T10:00:00Z"), finishedAt: new Date("2026-09-25T10:20:00Z") },
      { status: "completed" as const, startedAt: new Date("2026-09-25T10:00:00Z"), finishedAt: new Date("2026-09-25T10:40:00Z") },
      { status: "upcoming" as const },
    ];
    expect(matchStats(matches).avgDurationMinutes).toBe(30);
  });

  it("is null, not zero, when nothing has finished yet", () => {
    expect(matchStats([{ status: "upcoming" as const }]).avgDurationMinutes).toBeNull();
  });
});

describe("arenaUtilization", () => {
  it("groups by arena and counts live/completed within it", () => {
    const matches = [
      { arenaId: "a1", arenaName: "Arena A", status: "live" as const },
      { arenaId: "a1", arenaName: "Arena A", status: "completed" as const },
      { arenaId: "a2", arenaName: "Arena B", status: "upcoming" as const },
    ];
    const rows = arenaUtilization(matches);
    expect(rows).toEqual([
      { arenaId: "a1", arenaName: "Arena A", matchCount: 2, liveCount: 1, completedCount: 1 },
      { arenaId: "a2", arenaName: "Arena B", matchCount: 1, liveCount: 0, completedCount: 0 },
    ]);
  });

  it("skips matches with no arena assigned", () => {
    expect(arenaUtilization([{ arenaId: undefined, arenaName: undefined, status: "live" as const }])).toEqual([]);
  });
});

describe("mostActiveVolunteers", () => {
  it("counts score actions per volunteer, most active first", () => {
    const entries = [
      { createdBy: "v1", createdByName: "Priya" },
      { createdBy: "v2", createdByName: "Rohit" },
      { createdBy: "v1", createdByName: "Priya" },
      { createdBy: "v1", createdByName: "Priya" },
    ];
    const rows = mostActiveVolunteers(entries);
    expect(rows[0]).toEqual({ userId: "v1", name: "Priya", actionCount: 3 });
    expect(rows[1]).toEqual({ userId: "v2", name: "Rohit", actionCount: 1 });
  });

  it("falls back to the uid when no name is denormalised", () => {
    expect(mostActiveVolunteers([{ createdBy: "v1", createdByName: undefined }])[0]!.name).toBe("v1");
  });
});

describe("teamWinRate", () => {
  const team = (id: string, name: string) => ({ registrationId: id, name, isBye: false });

  it("counts a win for the winner and a loss for the loser", () => {
    const matches = [{ status: "completed" as const, winner: "home" as const, homeTeam: team("t1", "Alpha"), awayTeam: team("t2", "Beta") }];
    const rows = teamWinRate(matches);
    expect(rows.find((r) => r.registrationId === "t1")).toMatchObject({ wins: 1, losses: 0, winRate: 1 });
    expect(rows.find((r) => r.registrationId === "t2")).toMatchObject({ wins: 0, losses: 1, winRate: 0 });
  });

  it("ignores matches with no decided winner, and byes", () => {
    const matches = [
      { status: "live" as const, homeTeam: team("t1", "Alpha"), awayTeam: team("t2", "Beta") },
      { status: "completed" as const, winner: "home" as const, homeTeam: team("t3", "Gamma"), awayTeam: { name: "Bye", isBye: true } },
    ];
    expect(teamWinRate(matches)).toEqual([]);
  });

  it("sorts by win rate, then by matches played", () => {
    const matches = [
      { status: "completed" as const, winner: "home" as const, homeTeam: team("t1", "Alpha"), awayTeam: team("t2", "Beta") },
      { status: "completed" as const, winner: "home" as const, homeTeam: team("t1", "Alpha"), awayTeam: team("t3", "Gamma") },
      { status: "completed" as const, winner: "home" as const, homeTeam: team("t4", "Delta"), awayTeam: team("t5", "Epsilon") },
    ];
    const rows = teamWinRate(matches);
    expect(rows[0]!.registrationId).toBe("t1"); // 2 wins, both winRate 1, but more played
  });
});
