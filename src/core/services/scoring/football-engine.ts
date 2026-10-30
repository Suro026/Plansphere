import type { ScoreAction, ScoreState } from "@/core/models/match";
import { emptyScoreState, type ScoringEngine } from "./types";

/**
 * Goals, yellow and red cards. Also serves anything shaped like it — hockey,
 * robo soccer — since the actions and the scoreboard are identical.
 *
 * Time-based sports have no engine-computed end: a half-length clock is a
 * display hint (`matchConfig.halves`/`minutesPerHalf`), not something this
 * pure function can observe, so `isComplete` stays false and the volunteer's
 * explicit "Finish" action ends the match.
 */
interface FootballDetail {
  yellow: { home: number; away: number };
  red: { home: number; away: number };
}

const detailOf = (state: ScoreState): FootballDetail =>
  (state.detail as unknown as FootballDetail) ?? { yellow: { home: 0, away: 0 }, red: { home: 0, away: 0 } };

export const footballEngine: ScoringEngine = {
  matches: ["football", "soccer", "robo soccer", "hockey"],

  initialState(): ScoreState {
    return { ...emptyScoreState(), detail: { yellow: { home: 0, away: 0 }, red: { home: 0, away: 0 } } };
  },

  applyAction(state: ScoreState, action: ScoreAction): { state: ScoreState; label: string } {
    const side = action.side;
    const detail = detailOf(state);

    if (action.type === "goal" && side) {
      const next: ScoreState = {
        ...state,
        home: side === "home" ? state.home + 1 : state.home,
        away: side === "away" ? state.away + 1 : state.away,
      };
      next.displayHome = String(next.home);
      next.displayAway = String(next.away);
      return { state: next, label: "Goal" };
    }

    if (action.type === "yellow_card" && side) {
      const yellow = { ...detail.yellow, [side]: detail.yellow[side] + 1 };
      return { state: { ...state, detail: { ...detail, yellow } }, label: "Yellow card" };
    }

    if (action.type === "red_card" && side) {
      const red = { ...detail.red, [side]: detail.red[side] + 1 };
      return { state: { ...state, detail: { ...detail, red } }, label: "Red card" };
    }

    return { state, label: "" };
  },
};
