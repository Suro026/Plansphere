import type { MatchConfig, ScoreAction, ScoreState } from "@/core/models/match";
import type { MatchSide } from "@/core/models/match";
import { emptyScoreState, type ScoringEngine } from "./types";

/**
 * A limited-overs simplification, not a full simulation — this is for a
 * college's own tournament, not a professional match. Two innings, one side
 * batting at a time; an innings ends on overs exhausted, all out, or (in the
 * second innings) the chase being won. Extras, no-balls and free hits are
 * out of scope; a volunteer records a delivery as runs (0 for a dot ball) or
 * a wicket, each advancing the over.
 */
interface CricketDetail {
  innings: 1 | 2;
  battingSide: MatchSide;
  overs: number;
  balls: number;
  wickets: { home: number; away: number };
  firstInningsScore: number | null;
}

const initialDetail = (): CricketDetail => ({
  innings: 1,
  battingSide: "home",
  overs: 0,
  balls: 0,
  wickets: { home: 0, away: 0 },
  firstInningsScore: null,
});

const detailOf = (state: ScoreState): CricketDetail => (state.detail as unknown as CricketDetail) ?? initialDetail();

const display = (runs: number, wickets: number): string => `${runs}/${wickets}`;

const advanceBall = (detail: CricketDetail): CricketDetail => {
  const balls = detail.balls + 1;
  return balls === 6 ? { ...detail, balls: 0, overs: detail.overs + 1 } : { ...detail, balls };
};

export const cricketEngine: ScoringEngine = {
  matches: ["cricket"],

  initialState(): ScoreState {
    const detail = initialDetail();
    return { ...emptyScoreState(), detail: detail as unknown as Record<string, unknown>, displayHome: display(0, 0), displayAway: display(0, 0) };
  },

  applyAction(state: ScoreState, action: ScoreAction, config: MatchConfig): { state: ScoreState; label: string } {
    const detail = detailOf(state);
    const battingSide = detail.battingSide;
    const other = (side: MatchSide): MatchSide => (side === "home" ? "away" : "home");

    let home = state.home;
    let away = state.away;
    let wickets = detail.wickets;
    let label = "";

    if (action.type === "run") {
      const runs = Math.max(0, Number(action.payload?.runs ?? 0));
      if (battingSide === "home") home += runs;
      else away += runs;
      label = runs === 0 ? "Dot ball" : runs === 4 ? "Four" : runs === 6 ? "Six" : `${runs} run${runs === 1 ? "" : "s"}`;
    } else if (action.type === "wicket") {
      wickets = { ...wickets, [battingSide]: wickets[battingSide] + 1 };
      label = "Wicket";
    } else {
      return { state, label: "" };
    }

    let next = advanceBall({ ...detail, wickets });

    const currentRuns = battingSide === "home" ? home : away;
    const allOut = next.wickets[battingSide] >= config.maxPlayers - 1;
    const oversUp = config.overs !== undefined && next.overs >= config.overs && next.balls === 0;
    const chaseWon = next.innings === 2 && next.firstInningsScore !== null && currentRuns > next.firstInningsScore;

    let isComplete = false;
    if (chaseWon) {
      isComplete = true;
    } else if (allOut || oversUp) {
      if (next.innings === 1) {
        next = { innings: 2, battingSide: other(battingSide), overs: 0, balls: 0, wickets: next.wickets, firstInningsScore: currentRuns };
      } else {
        isComplete = true;
      }
    }

    const nextState: ScoreState = {
      ...state,
      home,
      away,
      detail: next as unknown as Record<string, unknown>,
      displayHome: display(home, next.wickets.home),
      displayAway: display(away, next.wickets.away),
      isComplete,
    };
    return { state: nextState, label };
  },
};
