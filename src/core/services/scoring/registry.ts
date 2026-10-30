import { cricketEngine } from "./cricket-engine";
import { footballEngine } from "./football-engine";
import { genericPointEngine } from "./generic-point-engine";
import { roboFightEngine } from "./robo-fight-engine";
import { normalizeSport } from "./types";
import type { ScoringEngine } from "./types";
import { volleyballEngine } from "./volleyball-engine";

const ENGINES: ScoringEngine[] = [footballEngine, cricketEngine, volleyballEngine, roboFightEngine];

/**
 * Which engine handles a sport, by its free-text `sportType`. Nothing
 * recognised — Robo Race, Coding Battle, Quiz, a made-up name — falls back
 * to `genericPointEngine`, which is exactly the sport-agnostic "goes up by
 * N, first to a target wins" scoreboard the spec calls for.
 */
export const getScoringEngine = (sportType: string | undefined): ScoringEngine => {
  const key = normalizeSport(sportType);
  return ENGINES.find((engine) => engine.matches.includes(key)) ?? genericPointEngine;
};
