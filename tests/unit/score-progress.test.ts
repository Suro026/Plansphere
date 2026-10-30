import { describe, expect, it } from "vitest";
import { scoreProgress } from "@/core/services/scoring/progress";
import { getScoringEngine } from "@/core/services/scoring";
import type { MatchConfig } from "@/core/models/match";

const config = { durationType: "sets", sets: 3, pointsPerSet: 11 } as unknown as MatchConfig;

describe("scoreProgress", () => {
  it("shows the live set tally for a set-based sport, moving with every point", () => {
    const engine = getScoringEngine("Volleyball");
    let state = engine.initialState(config);
    expect(scoreProgress(state)).toBe("Current set 0–0");
    state = engine.applyAction(state, { type: "point", side: "home" }, config).state;
    state = engine.applyAction(state, { type: "point", side: "home" }, config).state;
    state = engine.applyAction(state, { type: "point", side: "away" }, config).state;
    expect(scoreProgress(state)).toBe("Current set 2–1");
  });

  it("shows round and match points for robo fight, which the headline never counts", () => {
    const engine = getScoringEngine("Robo Fight");
    const roboConfig = { rounds: 3 } as unknown as MatchConfig;
    let state = engine.initialState(roboConfig);
    state = engine.applyAction(state, { type: "point", side: "home", payload: { value: 3 } }, roboConfig).state;
    expect(state.displayHome).toBe("0");
    expect(scoreProgress(state)).toBe("Round points 3–0 · match total 3–0");
  });

  it("copes with a bracket-created match whose detail starts empty", () => {
    expect(scoreProgress({ home: 0, away: 0, detail: {}, displayHome: "0", displayAway: "0", isComplete: false })).toBeNull();
  });

  it("has nothing to add for sports whose headline is the score", () => {
    const engine = getScoringEngine("Football");
    expect(scoreProgress(engine.initialState({} as MatchConfig))).toBeNull();
  });
});
