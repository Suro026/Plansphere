import type { Unsubscribe } from "../models/common";
import type { CreateMatchInput, Match, MatchStatus, ScoreAction, TournamentType, UpdateMatchInput } from "../models/match";
import type { MatchLogEntry } from "../models/match-log";

export interface MatchQuery {
  festId?: string;
  eventId?: string;
  arenaId?: string;
  status?: MatchStatus | MatchStatus[];
}

export interface MatchRepository {
  getById(id: string): Promise<Match | null>;

  subscribeById(
    id: string,
    onChange: (match: Match | null) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  listByEvent(eventId: string): Promise<Match[]>;

  subscribeByEvent(
    eventId: string,
    onChange: (matches: Match[]) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  /** Every match assigned to one arena, across events — the volunteer scorer's own view. */
  subscribeByArena(
    arenaId: string,
    onChange: (matches: Match[]) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  /** Every live match on the platform, for the public `/live` directory. No fest scope — a visitor has none. */
  subscribeLive(
    onChange: (matches: Match[]) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  listLogForMatch(matchId: string): Promise<MatchLogEntry[]>;

  subscribeLogForMatch(
    matchId: string,
    onChange: (entries: MatchLogEntry[]) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  /** Turns confirmed entries into a bracket. Replaces any bracket already generated for the event. */
  generateBracket(eventId: string, tournamentType: TournamentType): Promise<{ created: number }>;

  createMatch(input: CreateMatchInput): Promise<Match>;

  updateMatch(id: string, changes: UpdateMatchInput): Promise<void>;

  startMatch(id: string): Promise<void>;

  pauseMatch(id: string): Promise<void>;

  resumeMatch(id: string): Promise<void>;

  /** `winner` overrides the engine's own decision — a judge's call, or a walkover. */
  finishMatch(id: string, winner?: "home" | "away"): Promise<void>;

  scoreMatch(id: string, action: ScoreAction): Promise<void>;

  /** Marks the latest log entry undone and recomputes the score from the rest. */
  undoLastAction(id: string): Promise<void>;

  cancelMatch(id: string): Promise<void>;
}
