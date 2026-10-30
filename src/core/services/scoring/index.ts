export type { ScoringEngine } from "./types";
export { normalizeSport, emptyScoreState } from "./types";
export { getScoringEngine } from "./registry";
export { footballEngine } from "./football-engine";
export { cricketEngine } from "./cricket-engine";
export { volleyballEngine } from "./volleyball-engine";
export { roboFightEngine } from "./robo-fight-engine";
export { genericPointEngine } from "./generic-point-engine";

import { activeLog, type MatchLogEntry } from "@/core/models/match-log";
import type { MatchConfig, ScoreState } from "@/core/models/match";
import { getScoringEngine } from "./registry";

/**
 * The undo mechanism: a match's score is never edited in place, only ever
 * recomputed as the fold of its (non-undone) log over the engine's
 * `initialState`. Undo therefore just means "mark the last entry undone and
 * call this again" — there is no separate "reverse the last action" code
 * path to keep in sync with `applyAction`.
 */
export const replayScore = (sportType: string, config: MatchConfig, entries: readonly MatchLogEntry[]): ScoreState => {
  const engine = getScoringEngine(sportType);
  let state = engine.initialState(config);
  for (const entry of activeLog(entries)) {
    const result = engine.applyAction(state, { type: entry.type, side: entry.side, payload: entry.payload }, config);
    state = result.state;
  }
  return state;
};
