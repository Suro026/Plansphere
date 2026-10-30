import type { ScoreState } from "@/core/models/match";

/**
 * The score *inside* the current set or round.
 *
 * Set- and round-based engines (volleyball, table tennis, robo fight) keep
 * `score.home`/`away` as sets or rounds won, and the live tally of the set or
 * round in progress in `detail`. Showing only the headline made a scorer's
 * +1 look like it did nothing, so every screen that renders a live score also
 * renders this line. Returns `null` for sports whose headline already is the
 * score (football, cricket, generic points).
 */
const pairOf = (value: unknown): { home: number; away: number } | null => {
  if (value === null || typeof value !== "object") return null;
  const { home, away } = value as { home?: unknown; away?: unknown };
  return typeof home === "number" && typeof away === "number" ? { home, away } : null;
};

export const scoreProgress = (score: ScoreState): string | null => {
  const detail = (score.detail ?? {}) as Record<string, unknown>;

  const currentSet = pairOf(detail.currentSet);
  if (currentSet) return `Current set ${currentSet.home}–${currentSet.away}`;

  const round = pairOf(detail.roundPoints);
  if (round) {
    const total = pairOf(detail.totalPoints);
    return `Round points ${round.home}–${round.away}${total ? ` · match total ${total.home}–${total.away}` : ""}`;
  }

  return null;
};
