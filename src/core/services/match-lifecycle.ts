import type { MatchSide, ScoreState } from "../models/match";

/**
 * Who won, once a match is over. An explicit call (a judge's decision, a
 * walkover) always wins; otherwise the higher score does. A tied score with
 * no explicit call is not decidable — the caller must ask a human.
 */
export const decideWinner = (score: Pick<ScoreState, "home" | "away">, explicit?: MatchSide): MatchSide | null => {
  if (explicit) return explicit;
  if (score.home > score.away) return "home";
  if (score.away > score.home) return "away";
  return null;
};
