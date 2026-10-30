import type { MatchConfig, ScoreAction, ScoreState } from "@/core/models/match";

/**
 * The adapter every sport implements.
 *
 * A `ScoringEngine` never mutates: `applyAction` takes the state before an
 * action and returns the state after it, plus a label for the timeline. That
 * makes replay — the mechanism undo is built on — a fold over the log
 * rather than a special case: `entries.reduce(applyAction, initialState)`.
 */
export interface ScoringEngine {
  /** Normalised sport keys this engine claims — see `normalizeSport`. */
  readonly matches: readonly string[];
  initialState(config: MatchConfig): ScoreState;
  applyAction(state: ScoreState, action: ScoreAction, config: MatchConfig): { state: ScoreState; label: string };
}

/**
 * Lowercased, trimmed, punctuation collapsed to single spaces — "Robo-Fight",
 * "robo_fight" and "Robo Fight " all normalise to "robo fight", so an admin
 * typing a free-text `sportType` still reaches the right engine.
 */
export const normalizeSport = (sportType: string | undefined): string =>
  (sportType ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

const baseState = (): ScoreState => ({ home: 0, away: 0, detail: {}, displayHome: "0", displayAway: "0", isComplete: false });

export const emptyScoreState = baseState;
