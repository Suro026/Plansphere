import { describe, expect, it } from "vitest";
import type { MatchConfig, ScoreAction, ScoreState } from "@/core/models/match";
import type { MatchLogEntry } from "@/core/models/match-log";
import {
  cricketEngine,
  footballEngine,
  genericPointEngine,
  getScoringEngine,
  normalizeSport,
  replayScore,
  roboFightEngine,
  volleyballEngine,
} from "@/core/services/scoring";

const config = (over: Partial<MatchConfig> = {}): MatchConfig => ({ durationType: "time", maxPlayers: 11, ...over });

const apply = (engine: typeof footballEngine, state: ScoreState, action: ScoreAction, cfg: MatchConfig) => engine.applyAction(state, action, cfg).state;

describe("normalizeSport", () => {
  it("collapses case, punctuation and whitespace", () => {
    expect(normalizeSport("Robo-Fight")).toBe("robo fight");
    expect(normalizeSport("  Football  ")).toBe("football");
    expect(normalizeSport("robo_fight")).toBe("robo fight");
    expect(normalizeSport(undefined)).toBe("");
  });
});

describe("getScoringEngine", () => {
  it("resolves known sports to their engine", () => {
    expect(getScoringEngine("Football")).toBe(footballEngine);
    expect(getScoringEngine("robo soccer")).toBe(footballEngine);
    expect(getScoringEngine("Cricket")).toBe(cricketEngine);
    expect(getScoringEngine("Volleyball")).toBe(volleyballEngine);
    expect(getScoringEngine("Robo Fight")).toBe(roboFightEngine);
  });

  it("falls back to the generic engine for anything else", () => {
    expect(getScoringEngine("Robo Race")).toBe(genericPointEngine);
    expect(getScoringEngine("Coding Battle")).toBe(genericPointEngine);
    expect(getScoringEngine("Quiz")).toBe(genericPointEngine);
    expect(getScoringEngine(undefined)).toBe(genericPointEngine);
  });
});

describe("footballEngine", () => {
  const cfg = config({ durationType: "time", halves: 2, minutesPerHalf: 20 });

  it("counts goals per side", () => {
    let state = footballEngine.initialState(cfg);
    state = apply(footballEngine, state, { type: "goal", side: "home" }, cfg);
    state = apply(footballEngine, state, { type: "goal", side: "home" }, cfg);
    state = apply(footballEngine, state, { type: "goal", side: "away" }, cfg);
    expect(state.home).toBe(2);
    expect(state.away).toBe(1);
    expect(state.displayHome).toBe("2");
  });

  it("tracks cards without touching the score", () => {
    let state = footballEngine.initialState(cfg);
    state = apply(footballEngine, state, { type: "yellow_card", side: "home" }, cfg);
    state = apply(footballEngine, state, { type: "red_card", side: "away" }, cfg);
    expect(state.home).toBe(0);
    expect((state.detail as { yellow: { home: number } }).yellow.home).toBe(1);
    expect((state.detail as { red: { away: number } }).red.away).toBe(1);
  });

  it("never auto-completes a time-based match", () => {
    let state = footballEngine.initialState(cfg);
    for (let i = 0; i < 20; i += 1) state = apply(footballEngine, state, { type: "goal", side: "home" }, cfg);
    expect(state.isComplete).toBe(false);
  });

  it("ignores an action with no side", () => {
    const state = footballEngine.initialState(cfg);
    const { state: next, label } = footballEngine.applyAction(state, { type: "goal" }, cfg);
    expect(next).toEqual(state);
    expect(label).toBe("");
  });
});

describe("cricketEngine", () => {
  const cfg = config({ durationType: "overs", overs: 2, maxPlayers: 3 }); // 2 wickets = all out, for a short test

  it("advances the over every 6 balls", () => {
    let state = cricketEngine.initialState(cfg);
    for (let i = 0; i < 6; i += 1) state = apply(cricketEngine, state, { type: "run", payload: { runs: 1 } }, cfg);
    expect((state.detail as { overs: number; balls: number }).overs).toBe(1);
    expect((state.detail as { balls: number }).balls).toBe(0);
  });

  it("accumulates runs for the batting side and formats runs/wickets", () => {
    let state = cricketEngine.initialState(cfg);
    state = apply(cricketEngine, state, { type: "run", payload: { runs: 4 } }, cfg);
    state = apply(cricketEngine, state, { type: "run", payload: { runs: 6 } }, cfg);
    expect(state.home).toBe(10);
    expect(state.displayHome).toBe("10/0");
  });

  it("labels boundaries and dot balls", () => {
    const state = cricketEngine.initialState(cfg);
    expect(cricketEngine.applyAction(state, { type: "run", payload: { runs: 4 } }, cfg).label).toBe("Four");
    expect(cricketEngine.applyAction(state, { type: "run", payload: { runs: 6 } }, cfg).label).toBe("Six");
    expect(cricketEngine.applyAction(state, { type: "run", payload: { runs: 0 } }, cfg).label).toBe("Dot ball");
    expect(cricketEngine.applyAction(state, { type: "wicket" }, cfg).label).toBe("Wicket");
  });

  it("ends the first innings when all out and swaps the batting side", () => {
    let state = cricketEngine.initialState(cfg);
    state = apply(cricketEngine, state, { type: "run", payload: { runs: 20 } }, cfg);
    state = apply(cricketEngine, state, { type: "wicket" }, cfg);
    state = apply(cricketEngine, state, { type: "wicket" }, cfg); // 2 wickets = all out at maxPlayers 3
    const detail = state.detail as { innings: number; battingSide: string; firstInningsScore: number };
    expect(detail.innings).toBe(2);
    expect(detail.battingSide).toBe("away");
    expect(detail.firstInningsScore).toBe(20);
    expect(state.isComplete).toBe(false);
  });

  it("ends the first innings when overs run out", () => {
    let state = cricketEngine.initialState(cfg);
    for (let i = 0; i < 12; i += 1) state = apply(cricketEngine, state, { type: "run", payload: { runs: 1 } }, cfg); // 2 overs
    expect((state.detail as { innings: number }).innings).toBe(2);
  });

  it("completes the match when the chasing side wins early", () => {
    let state = cricketEngine.initialState(cfg);
    state = apply(cricketEngine, state, { type: "run", payload: { runs: 10 } }, cfg);
    state = apply(cricketEngine, state, { type: "wicket" }, cfg);
    state = apply(cricketEngine, state, { type: "wicket" }, cfg); // all out, innings 2 starts, away batting
    state = apply(cricketEngine, state, { type: "run", payload: { runs: 11 } }, cfg); // away passes 10
    expect(state.isComplete).toBe(true);
    expect(state.away).toBe(11);
  });

  it("completes the match when the second innings' overs run out without a chase", () => {
    let state = cricketEngine.initialState(cfg);
    state = apply(cricketEngine, state, { type: "run", payload: { runs: 30 } }, cfg);
    state = apply(cricketEngine, state, { type: "wicket" }, cfg);
    state = apply(cricketEngine, state, { type: "wicket" }, cfg); // innings 2 begins
    for (let i = 0; i < 12; i += 1) state = apply(cricketEngine, state, { type: "run", payload: { runs: 1 } }, cfg);
    expect(state.isComplete).toBe(true);
    expect(state.away).toBe(12);
  });
});

describe("volleyballEngine", () => {
  const cfg = config({ durationType: "sets", sets: 3, pointsPerSet: 5 });

  it("wins a set at the target with a two-point lead", () => {
    let state = volleyballEngine.initialState(cfg);
    for (let i = 0; i < 5; i += 1) state = apply(volleyballEngine, state, { type: "point", side: "home" }, cfg);
    expect(state.home).toBe(1);
    expect((state.detail as { currentSet: { home: number } }).currentSet.home).toBe(0);
  });

  it("does not award the set at 5-4 without a two-point lead", () => {
    let state = volleyballEngine.initialState(cfg);
    for (let i = 0; i < 4; i += 1) state = apply(volleyballEngine, state, { type: "point", side: "home" }, cfg);
    for (let i = 0; i < 4; i += 1) state = apply(volleyballEngine, state, { type: "point", side: "away" }, cfg);
    state = apply(volleyballEngine, state, { type: "point", side: "home" }, cfg); // 5-4
    expect(state.home).toBe(0);
    state = apply(volleyballEngine, state, { type: "point", side: "home" }, cfg); // 6-4, two clear
    expect(state.home).toBe(1);
  });

  it("completes the match once a side wins a majority of sets", () => {
    let state = volleyballEngine.initialState(cfg);
    const winSet = (side: "home" | "away") => {
      for (let i = 0; i < 5; i += 1) state = apply(volleyballEngine, state, { type: "point", side }, cfg);
    };
    winSet("home");
    expect(state.isComplete).toBe(false);
    winSet("home");
    expect(state.isComplete).toBe(true);
    expect(state.home).toBe(2);
  });
});

describe("roboFightEngine", () => {
  const cfg = config({ durationType: "rounds", rounds: 3 });

  it("counts round wins as the primary score", () => {
    let state = roboFightEngine.initialState(cfg);
    state = apply(roboFightEngine, state, { type: "round_win", side: "home" }, cfg);
    expect(state.home).toBe(1);
  });

  it("tracks cumulative points separately from rounds", () => {
    let state = roboFightEngine.initialState(cfg);
    state = apply(roboFightEngine, state, { type: "point", side: "home", payload: { value: 3 } }, cfg);
    state = apply(roboFightEngine, state, { type: "round_win", side: "home" }, cfg);
    state = apply(roboFightEngine, state, { type: "point", side: "away", payload: { value: 2 } }, cfg);
    const detail = state.detail as { totalPoints: { home: number; away: number } };
    expect(detail.totalPoints).toEqual({ home: 3, away: 2 });
  });

  it("resets in-round points once a round is won", () => {
    let state = roboFightEngine.initialState(cfg);
    state = apply(roboFightEngine, state, { type: "point", side: "home", payload: { value: 5 } }, cfg);
    state = apply(roboFightEngine, state, { type: "round_win", side: "home" }, cfg);
    expect((state.detail as { roundPoints: { home: number } }).roundPoints.home).toBe(0);
  });

  it("completes the match at a majority of rounds", () => {
    let state = roboFightEngine.initialState(cfg);
    state = apply(roboFightEngine, state, { type: "round_win", side: "away" }, cfg);
    expect(state.isComplete).toBe(false);
    state = apply(roboFightEngine, state, { type: "round_win", side: "away" }, cfg);
    expect(state.isComplete).toBe(true);
  });

  it("scores from a bracket-generated match, whose detail starts empty", () => {
    // The bracket route writes `detail: {}` rather than calling initialState().
    const fresh: ScoreState = { home: 0, away: 0, detail: {}, displayHome: "0", displayAway: "0", isComplete: false };
    const afterPoint = apply(roboFightEngine, fresh, { type: "point", side: "home", payload: { value: 4 } }, cfg);
    expect((afterPoint.detail as { totalPoints: { home: number; away: number } }).totalPoints).toEqual({ home: 4, away: 0 });
    const afterRound = apply(roboFightEngine, fresh, { type: "round_win", side: "away" }, cfg);
    expect(afterRound.away).toBe(1);
  });
});

describe("genericPointEngine", () => {
  it("adds a point (or a given value) to a side", () => {
    let state = genericPointEngine.initialState(config());
    state = apply(genericPointEngine, state, { type: "point", side: "home" }, config());
    state = apply(genericPointEngine, state, { type: "point", side: "away", payload: { value: 3 } }, config());
    expect(state.home).toBe(1);
    expect(state.away).toBe(3);
  });

  it("completes at a target score only when durationType is points", () => {
    const cfg = config({ durationType: "points", targetPoints: 10 });
    let state = genericPointEngine.initialState(cfg);
    state = apply(genericPointEngine, state, { type: "point", side: "home", payload: { value: 10 } }, cfg);
    expect(state.isComplete).toBe(true);

    const untimed = config({ durationType: "time" });
    let open = genericPointEngine.initialState(untimed);
    open = apply(genericPointEngine, open, { type: "point", side: "home", payload: { value: 999 } }, untimed);
    expect(open.isComplete).toBe(false);
  });
});

describe("replayScore — the undo mechanism", () => {
  const cfg = config({ durationType: "time" });
  const entry = (over: Partial<MatchLogEntry>): MatchLogEntry => ({
    id: "e1",
    matchId: "m1",
    festId: "f1",
    eventId: "ev1",
    type: "goal",
    side: "home",
    label: "Goal",
    undone: false,
    at: new Date("2026-09-25T10:00:00Z"),
    createdBy: "vol1",
    ...over,
  });

  it("replays every non-undone entry, in order, to reach the current score", () => {
    const entries = [
      entry({ id: "e1", side: "home", at: new Date("2026-09-25T10:00:00Z") }),
      entry({ id: "e2", side: "away", at: new Date("2026-09-25T10:05:00Z") }),
      entry({ id: "e3", side: "home", at: new Date("2026-09-25T10:10:00Z") }),
    ];
    const score = replayScore("football", cfg, entries);
    expect(score).toMatchObject({ home: 2, away: 1 });
  });

  it("skips undone entries, which is what makes undo work", () => {
    const entries = [
      entry({ id: "e1", side: "home" }),
      entry({ id: "e2", side: "home", undone: true }),
    ];
    const score = replayScore("football", cfg, entries);
    expect(score.home).toBe(1);
  });

  it("replays out of insertion order by timestamp, not array order", () => {
    const entries = [
      entry({ id: "e2", side: "away", at: new Date("2026-09-25T10:05:00Z") }),
      entry({ id: "e1", side: "home", at: new Date("2026-09-25T10:00:00Z") }),
    ];
    const score = replayScore("football", cfg, entries);
    expect(score).toMatchObject({ home: 1, away: 1 });
  });
});
