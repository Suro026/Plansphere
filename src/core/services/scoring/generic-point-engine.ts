import type { MatchConfig, ScoreAction, ScoreState } from "@/core/models/match";
import { emptyScoreState, type ScoringEngine } from "./types";

/**
 * The fallback for any sport with no dedicated engine — basketball, robo
 * race, a coding battle, a quiz, or whatever an admin types that nothing
 * else claims. One action, "point", with an optional value (basketball's
 * 2s and 3s); a target score finishes the match automatically when
 * `matchConfig.durationType` is "points", otherwise a volunteer finishes it
 * by hand.
 */
export const genericPointEngine: ScoringEngine = {
  matches: [],

  initialState(): ScoreState {
    return emptyScoreState();
  },

  applyAction(state: ScoreState, action: ScoreAction, config: MatchConfig): { state: ScoreState; label: string } {
    if (action.type !== "point" || !action.side) return { state, label: "" };
    const value = Math.max(0, Number(action.payload?.value ?? 1));
    const home = action.side === "home" ? state.home + value : state.home;
    const away = action.side === "away" ? state.away + value : state.away;

    const target = config.durationType === "points" ? config.targetPoints : undefined;
    const isComplete = target !== undefined && (home >= target || away >= target);

    return {
      state: { ...state, home, away, displayHome: String(home), displayAway: String(away), isComplete },
      label: value === 1 ? "Point" : `${value} points`,
    };
  },
};
