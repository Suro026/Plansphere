import type { Match } from "../models/match";
import type { MatchLogEntry } from "../models/match-log";

/**
 * Pure aggregation over matches and their timelines — the Live Event
 * Engine's contribution to the analytics module (Part 6). Same shape as
 * `core/services/fest-analytics.ts`: callers own the Firestore query, these
 * functions only own the arithmetic.
 */

export interface MatchStats {
  total: number;
  live: number;
  upcoming: number;
  completed: number;
  cancelled: number;
  /** Null when no match has both a start and a finish to measure from. */
  avgDurationMinutes: number | null;
}

export const matchStats = (matches: readonly Pick<Match, "status" | "startedAt" | "finishedAt">[]): MatchStats => {
  const durations: number[] = [];
  for (const m of matches) {
    if (m.startedAt && m.finishedAt) durations.push((m.finishedAt.getTime() - m.startedAt.getTime()) / 60000);
  }
  return {
    total: matches.length,
    live: matches.filter((m) => m.status === "live").length,
    upcoming: matches.filter((m) => m.status === "upcoming").length,
    completed: matches.filter((m) => m.status === "completed").length,
    cancelled: matches.filter((m) => m.status === "cancelled").length,
    avgDurationMinutes: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
  };
};

export interface ArenaUtilization {
  arenaId: string;
  arenaName: string;
  matchCount: number;
  liveCount: number;
  completedCount: number;
}

export const arenaUtilization = (matches: readonly Pick<Match, "arenaId" | "arenaName" | "status">[]): ArenaUtilization[] => {
  const rows = new Map<string, ArenaUtilization>();
  for (const m of matches) {
    if (!m.arenaId) continue;
    const row = rows.get(m.arenaId) ?? { arenaId: m.arenaId, arenaName: m.arenaName ?? m.arenaId, matchCount: 0, liveCount: 0, completedCount: 0 };
    row.matchCount += 1;
    if (m.status === "live") row.liveCount += 1;
    if (m.status === "completed") row.completedCount += 1;
    rows.set(m.arenaId, row);
  }
  return [...rows.values()].sort((a, b) => b.matchCount - a.matchCount);
};

export interface VolunteerActivity {
  userId: string;
  name: string;
  actionCount: number;
}

/** Who has scored the most, across every match's timeline. Undone entries still counted — the tap happened. */
export const mostActiveVolunteers = (entries: readonly Pick<MatchLogEntry, "createdBy" | "createdByName">[]): VolunteerActivity[] => {
  const rows = new Map<string, VolunteerActivity>();
  for (const e of entries) {
    const row = rows.get(e.createdBy) ?? { userId: e.createdBy, name: e.createdByName ?? e.createdBy, actionCount: 0 };
    row.actionCount += 1;
    if (!row.name && e.createdByName) row.name = e.createdByName;
    rows.set(e.createdBy, row);
  }
  return [...rows.values()].sort((a, b) => b.actionCount - a.actionCount);
};

export interface TeamWinRate {
  registrationId: string;
  name: string;
  wins: number;
  losses: number;
  played: number;
  winRate: number;
}

/** Wins and losses per team, from completed matches with a decided winner. Byes never played, so they never count. */
export const teamWinRate = (matches: readonly Pick<Match, "homeTeam" | "awayTeam" | "winner" | "status">[]): TeamWinRate[] => {
  const rows = new Map<string, TeamWinRate>();
  const bump = (registrationId: string | undefined, name: string, won: boolean) => {
    if (!registrationId) return;
    const row = rows.get(registrationId) ?? { registrationId, name, wins: 0, losses: 0, played: 0, winRate: 0 };
    row.played += 1;
    if (won) row.wins += 1;
    else row.losses += 1;
    rows.set(registrationId, row);
  };

  for (const m of matches) {
    if (m.status !== "completed" || !m.winner) continue;
    if (m.homeTeam?.isBye || m.awayTeam?.isBye) continue;
    bump(m.homeTeam?.registrationId, m.homeTeam?.name ?? "", m.winner === "home");
    bump(m.awayTeam?.registrationId, m.awayTeam?.name ?? "", m.winner === "away");
  }

  for (const row of rows.values()) row.winRate = row.played > 0 ? row.wins / row.played : 0;
  return [...rows.values()].sort((a, b) => b.winRate - a.winRate || b.played - a.played);
};
