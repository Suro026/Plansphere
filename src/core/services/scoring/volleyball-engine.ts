import type { MatchConfig, ScoreAction, ScoreState } from "@/core/models/match";
import type { MatchSide } from "@/core/models/match";
import { emptyScoreState, type ScoringEngine } from "./types";

/**
 * Best-of-`sets` sets, each first to `pointsPerSet` and won by two clear
 * points — the standard rally-point rule, and the one thing that keeps a
 * 24-24 set from ending on a single point. `score.home`/`away` are sets
 * won (what a scoreboard shows first); the live point count for the set in
 * progress lives in `detail.currentSet`.
 */
interface VolleyballDetail {
  currentSet: { home: number; away: number };
}

const detailOf = (state: ScoreState): VolleyballDetail => (state.detail as unknown as VolleyballDetail) ?? { currentSet: { home: 0, away: 0 } };

export const volleyballEngine: ScoringEngine = {
  matches: ["volleyball", "badminton", "table tennis"],

  initialState(): ScoreState {
    return { ...emptyScoreState(), detail: { currentSet: { home: 0, away: 0 } } };
  },

  applyAction(state: ScoreState, action: ScoreAction, config: MatchConfig): { state: ScoreState; label: string } {
    if (action.type !== "point" || !action.side) return { state, label: "" };
    const side: MatchSide = action.side;
    const other: MatchSide = side === "home" ? "away" : "home";
    const detail = detailOf(state);

    const currentSet = { ...detail.currentSet, [side]: detail.currentSet[side] + 1 };
    const target = config.pointsPerSet ?? 25;
    const setsToWin = Math.ceil((config.sets ?? 3) / 2);

    const wonSet = currentSet[side] >= target && currentSet[side] - currentSet[other] >= 2;

    let home = state.home;
    let away = state.away;
    let nextCurrentSet = currentSet;
    let isComplete = false;

    if (wonSet) {
      if (side === "home") home += 1;
      else away += 1;
      nextCurrentSet = { home: 0, away: 0 };
      isComplete = (side === "home" ? home : away) >= setsToWin;
    }

    return {
      state: {
        ...state,
        home,
        away,
        detail: { currentSet: nextCurrentSet },
        displayHome: String(home),
        displayAway: String(away),
        isComplete,
      },
      label: wonSet ? `Set won` : "Point",
    };
  },
};
