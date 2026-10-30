import { doc, getDoc, getDocs, onSnapshot, query, where } from "firebase/firestore";
import type { Unsubscribe } from "@/core/models/common";
import {
  matchSchema,
  type CreateMatchInput,
  type Match,
  type ScoreAction,
  type TournamentType,
  type UpdateMatchInput,
} from "@/core/models/match";
import { matchLogEntrySchema, type MatchLogEntry } from "@/core/models/match-log";
import type { MatchRepository } from "@/core/repositories/match-repository";
import { api } from "@/data/api-client";
import { COLLECTIONS } from "../client";
import { guard, toRepositoryError } from "../mapping";
import { col, parseDoc, parseDocs, sortBy, subscribeList } from "../query-helpers";

const matches = () => col(COLLECTIONS.matches);
const matchLog = () => col(COLLECTIONS.matchLog);

const byRound = (items: Match[]) => sortBy(items, [(m) => m.round, "asc"], [(m) => m.matchIndex, "asc"]);
const byTime = (items: MatchLogEntry[]) => sortBy(items, [(e) => e.at, "asc"]);

const parseFromApi = (raw: unknown): Match => {
  const parsed = matchSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Server returned an unexpected match shape");
  return parsed.data;
};

/**
 * Matches (and their timelines) are public to read — a QR code away from a
 * scoreboard needs no account — and server-only to write. Every write here
 * goes through `/api/volunteer/matches/[id]/action`, whose one job is to
 * enforce "your arena only" for a volunteer and to append the audit trail
 * atomically with the score change.
 */
export class FirestoreMatchRepository implements MatchRepository {
  getById(id: string): Promise<Match | null> {
    return guard("Loading match", async () => {
      const snapshot = await getDoc(doc(matches(), id));
      return snapshot.exists() ? parseDoc(matchSchema, snapshot, COLLECTIONS.matches) : null;
    });
  }

  subscribeById(id: string, onChange: (match: Match | null) => void, onError: (error: unknown) => void): Unsubscribe {
    return onSnapshot(
      doc(matches(), id),
      (snapshot) => onChange(snapshot.exists() ? parseDoc(matchSchema, snapshot, COLLECTIONS.matches) : null),
      (error) => onError(toRepositoryError(error, "Listening to match")),
    );
  }

  listByEvent(eventId: string): Promise<Match[]> {
    return guard("Loading matches", async () => {
      const snapshot = await getDocs(query(matches(), where("eventId", "==", eventId)));
      return byRound(parseDocs(matchSchema, snapshot.docs, COLLECTIONS.matches));
    });
  }

  subscribeByEvent(eventId: string, onChange: (items: Match[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(query(matches(), where("eventId", "==", eventId)), matchSchema, COLLECTIONS.matches, (items) => onChange(byRound(items)), onError);
  }

  subscribeByArena(arenaId: string, onChange: (items: Match[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(query(matches(), where("arenaId", "==", arenaId)), matchSchema, COLLECTIONS.matches, (items) => onChange(byRound(items)), onError);
  }

  subscribeLive(onChange: (items: Match[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(query(matches(), where("status", "==", "live")), matchSchema, COLLECTIONS.matches, onChange, onError);
  }

  listLogForMatch(matchId: string): Promise<MatchLogEntry[]> {
    return guard("Loading match timeline", async () => {
      const snapshot = await getDocs(query(matchLog(), where("matchId", "==", matchId)));
      return byTime(parseDocs(matchLogEntrySchema, snapshot.docs, COLLECTIONS.matchLog));
    });
  }

  subscribeLogForMatch(matchId: string, onChange: (items: MatchLogEntry[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(query(matchLog(), where("matchId", "==", matchId)), matchLogEntrySchema, COLLECTIONS.matchLog, (items) => onChange(byTime(items)), onError);
  }

  generateBracket(eventId: string, tournamentType: TournamentType): Promise<{ created: number }> {
    return guard("Generating bracket", () => api<{ created: number }>(`/api/admin/events/${eventId}/bracket`, { method: "POST", body: { tournamentType } }));
  }

  createMatch(input: CreateMatchInput): Promise<Match> {
    return guard("Creating match", async () => {
      const response = await api<{ match: unknown }>("/api/admin/matches", { method: "POST", body: input });
      return parseFromApi(response.match);
    });
  }

  updateMatch(id: string, changes: UpdateMatchInput): Promise<void> {
    return guard("Saving match", () => api<void>(`/api/admin/matches/${id}`, { method: "PATCH", body: changes }));
  }

  private action(id: string, body: Record<string, unknown>): Promise<void> {
    return guard("Updating match", () => api<void>(`/api/volunteer/matches/${id}/action`, { method: "POST", body }));
  }

  startMatch(id: string): Promise<void> {
    return this.action(id, { action: "start" });
  }

  pauseMatch(id: string): Promise<void> {
    return this.action(id, { action: "pause" });
  }

  resumeMatch(id: string): Promise<void> {
    return this.action(id, { action: "resume" });
  }

  finishMatch(id: string, winner?: "home" | "away"): Promise<void> {
    return this.action(id, { action: "finish", winner });
  }

  scoreMatch(id: string, scoreAction: ScoreAction): Promise<void> {
    return this.action(id, { action: "score", scoreAction });
  }

  undoLastAction(id: string): Promise<void> {
    return this.action(id, { action: "undo" });
  }

  cancelMatch(id: string): Promise<void> {
    return this.action(id, { action: "cancel" });
  }
}
