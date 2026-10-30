import { z } from "zod";
import { auditFieldsSchema, dateSchema, idSchema, shortTextSchema } from "./common";

/**
 * The Live Event Engine's tournament and match shapes.
 *
 * One event optionally turns on "live mode" and picks a shape (knockout,
 * league, ...) and a sport. Everything about how a match is played —
 * halves, overs, sets, rounds, points — is data on `matchConfig`, never a
 * hardcoded assumption; a scoring engine (`core/services/scoring`) reads it
 * to know when a match ends and what a scoreboard looks like.
 */

export const TOURNAMENT_TYPES = ["knockout", "league", "round_robin", "swiss", "custom"] as const;
export const tournamentTypeSchema = z.enum(TOURNAMENT_TYPES);
export type TournamentType = z.infer<typeof tournamentTypeSchema>;

export const TOURNAMENT_TYPE_LABELS: Record<TournamentType, string> = {
  knockout: "Knockout",
  league: "League",
  round_robin: "Round robin",
  swiss: "Swiss",
  custom: "Custom",
};

/**
 * A sport is free text — "Robo Fight", "Quiz", anything an admin types — so
 * the engine registry (`core/services/scoring`) matches on a normalised
 * (lowercased, punctuation-stripped) form rather than a closed enum.
 */
export const sportTypeSchema = shortTextSchema;

export const MATCH_DURATION_TYPES = ["time", "overs", "sets", "rounds", "points"] as const;
export const matchDurationTypeSchema = z.enum(MATCH_DURATION_TYPES);
export type MatchDurationType = z.infer<typeof matchDurationTypeSchema>;

/**
 * One event's rulebook. Every field but `durationType` and `maxPlayers` is
 * optional because only some sports use it — a quiz has no halves, a relay
 * has no overs — and a scoring engine reads only the ones its sport needs.
 */
export const matchConfigSchema = z.object({
  durationType: matchDurationTypeSchema,
  /** Football, hockey: two halves of N minutes each. */
  halves: z.number().int().min(1).max(4).optional(),
  minutesPerHalf: z.number().int().min(1).max(120).optional(),
  /** Cricket: innings length. */
  overs: z.number().int().min(1).max(50).optional(),
  /** Volleyball, badminton: best-of-N sets, each to a point target. */
  sets: z.number().int().min(1).max(9).optional(),
  pointsPerSet: z.number().int().min(1).max(100).optional(),
  /** Robo Fight and similar: best-of-N rounds. */
  rounds: z.number().int().min(1).max(20).optional(),
  /** Any target-score sport not otherwise shaped (a quiz, a coding battle). */
  targetPoints: z.number().int().min(1).max(10000).optional(),
  maxPlayers: z.number().int().min(1).max(50).default(11),
});

export type MatchConfig = z.infer<typeof matchConfigSchema>;

export const MATCH_STATUSES = ["upcoming", "live", "completed", "cancelled"] as const;
export const matchStatusSchema = z.enum(MATCH_STATUSES);
export type MatchStatus = z.infer<typeof matchStatusSchema>;

/** One side of a match — a registration, or an explicit bye that auto-advances the other side. */
export const matchParticipantSchema = z.object({
  registrationId: idSchema.optional(),
  name: shortTextSchema,
  isBye: z.boolean().default(false),
});

export type MatchParticipant = z.infer<typeof matchParticipantSchema>;

export const MATCH_SIDES = ["home", "away"] as const;
export const matchSideSchema = z.enum(MATCH_SIDES);
export type MatchSide = z.infer<typeof matchSideSchema>;

/**
 * The scoring engine's working state, stored as `Match.score`.
 *
 * `home`/`away` are the one number every sport can be sorted and displayed
 * by (goals, runs, points, sets won); `detail` is whatever the sport's own
 * engine needs beyond that (cards, overs bowled, wickets, per-set scores,
 * rounds won) and no other code reads it. `display*` are pre-formatted so
 * the live pages render one sport exactly like another.
 */
export const scoreStateSchema = z.object({
  home: z.number().default(0),
  away: z.number().default(0),
  detail: z.record(z.string(), z.unknown()).default({}),
  displayHome: z.string().default("0"),
  displayAway: z.string().default("0"),
  isComplete: z.boolean().default(false),
});

export type ScoreState = z.infer<typeof scoreStateSchema>;

export const matchSchema = z
  .object({
    id: idSchema,
    festId: idSchema,
    eventId: idSchema,

    /** 1 = first round; increases toward the final. Meaningless for round-robin, kept at 1. */
    round: z.number().int().min(1).default(1),
    /** "Round of 16", "Quarterfinal", "Round 3" — precomputed so no page re-derives it. */
    roundLabel: shortTextSchema,
    /** Position within the round, for bracket layout (top to bottom). */
    matchIndex: z.number().int().min(0).default(0),

    homeTeam: matchParticipantSchema.nullable().default(null),
    awayTeam: matchParticipantSchema.nullable().default(null),
    winner: matchSideSchema.optional(),

    arenaId: idSchema.optional(),
    /** Denormalised for the live pages, which read matches far more than arenas change name. */
    arenaName: shortTextSchema.optional(),

    startTime: dateSchema.optional(),
    status: matchStatusSchema.default("upcoming"),
    /** True while `status` is "live" but a volunteer has paused the clock. */
    paused: z.boolean().default(false),

    sportType: sportTypeSchema,
    matchConfig: matchConfigSchema,
    score: scoreStateSchema.default({ home: 0, away: 0, detail: {}, displayHome: "0", displayAway: "0", isComplete: false }),

    /** Knockout only: where this match's winner advances to. Absent on the final. */
    nextMatchId: idSchema.optional(),
    nextMatchSlot: matchSideSchema.optional(),

    startedAt: dateSchema.optional(),
    finishedAt: dateSchema.optional(),

    createdBy: idSchema,
  })
  .merge(auditFieldsSchema);

export type Match = z.infer<typeof matchSchema>;

/** A match with no `nextMatchId` in a knockout bracket is the final. */
export const isFinalMatch = (match: Pick<Match, "nextMatchId">): boolean => !match.nextMatchId;

/** The winning side's display name, once decided. */
export const matchWinnerName = (match: Pick<Match, "winner" | "homeTeam" | "awayTeam">): string | null => {
  if (!match.winner) return null;
  const side = match.winner === "home" ? match.homeTeam : match.awayTeam;
  return side?.name ?? null;
};

/** Can this match be scored right now — live, or upcoming and about to start? */
export const isScoreable = (match: Pick<Match, "status">): boolean => match.status === "live" || match.status === "upcoming";

export const createArenaMatchSchema = z.object({
  festId: idSchema,
  eventId: idSchema,
  arenaId: idSchema.optional(),
  startTime: z.coerce.date().optional(),
  homeTeam: matchParticipantSchema.nullable().optional(),
  awayTeam: matchParticipantSchema.nullable().optional(),
  round: z.number().int().min(1).optional(),
  roundLabel: shortTextSchema.optional(),
  matchIndex: z.number().int().min(0).optional(),
});

export type CreateMatchInput = z.infer<typeof createArenaMatchSchema>;

export const updateMatchSchema = z.object({
  arenaId: idSchema.optional(),
  startTime: z.coerce.date().optional(),
  homeTeam: matchParticipantSchema.nullable().optional(),
  awayTeam: matchParticipantSchema.nullable().optional(),
  status: matchStatusSchema.optional(),
});

export type UpdateMatchInput = z.infer<typeof updateMatchSchema>;

/* ───────────── scoring actions ───────────── */

/**
 * What a volunteer's tap sends. `type` is sport-specific ("goal",
 * "wicket", "point", ...) and each engine only recognises its own; an
 * unrecognised type is a no-op rather than an error, so a stale client
 * cannot corrupt a match it has old expectations about.
 */
export const scoreActionSchema = z.object({
  type: z.string().trim().min(1).max(60),
  side: matchSideSchema.optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ScoreAction = z.infer<typeof scoreActionSchema>;
