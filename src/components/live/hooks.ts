"use client";

import * as React from "react";
import { useRepositories } from "@/components/providers";
import { useLive } from "@/components/admin/hooks";
import type { Arena } from "@/core/models/arena";
import type { Match } from "@/core/models/match";
import type { MatchLogEntry } from "@/core/models/match-log";

/**
 * Live Event Engine data hooks — thin wrappers over the repository
 * subscriptions, same shape as `components/admin/hooks.ts`. Nothing here
 * checks who is signed in: matches and arenas are public reads, so the same
 * hooks power the volunteer scorer, the admin bracket screen and the
 * anonymous `/live` pages alike.
 */

export const useFestArenas = (festId: string) => {
  const repos = useRepositories();
  return useLive<Arena[]>((onChange, onError) => repos.arenas.subscribeByFest(festId, onChange, onError), [festId, repos]);
};

export const useEventMatches = (eventId: string | undefined) => {
  const repos = useRepositories();
  return useLive<Match[]>((onChange, onError) => (eventId ? repos.matches.subscribeByEvent(eventId, onChange, onError) : () => undefined), [eventId, repos]);
};

export const useArenaMatches = (arenaId: string | undefined) => {
  const repos = useRepositories();
  return useLive<Match[]>((onChange, onError) => (arenaId ? repos.matches.subscribeByArena(arenaId, onChange, onError) : () => undefined), [arenaId, repos]);
};

export const useMatch = (matchId: string | undefined) => {
  const repos = useRepositories();
  return useLive<Match | null>((onChange, onError) => (matchId ? repos.matches.subscribeById(matchId, onChange, onError) : () => undefined), [matchId, repos]);
};

export const useMatchLog = (matchId: string | undefined) => {
  const repos = useRepositories();
  return useLive<MatchLogEntry[]>((onChange, onError) => (matchId ? repos.matches.subscribeLogForMatch(matchId, onChange, onError) : () => undefined), [matchId, repos]);
};

/** Every live match on the platform — the public `/live` directory. */
export const useLiveMatches = () => {
  const repos = useRepositories();
  return useLive<Match[]>((onChange, onError) => repos.matches.subscribeLive(onChange, onError), [repos]);
};

/** A volunteer's own scoring shifts for a fest — which arenas they may score at. */
export const useMyScoringArenaIds = (festId: string, userId: string | undefined) => {
  const repos = useRepositories();
  const shifts = useLive<import("@/core/models/shift").Shift[]>(
    (onChange, onError) => (userId ? repos.shifts.subscribeForUser(festId, userId, onChange, onError) : () => undefined),
    [festId, userId, repos],
  );
  return React.useMemo(() => new Set((shifts.data ?? []).filter((s) => s.duty === "scoring" && !s.cancelled).map((s) => s.post)), [shifts.data]);
};
