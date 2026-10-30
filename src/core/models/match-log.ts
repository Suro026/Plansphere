import { z } from "zod";
import { idSchema, shortTextSchema } from "./common";
import { matchSideSchema } from "./match";

/**
 * One entry per score action, in the order it happened — a match's timeline
 * ("03' Goal", "0.3 Wicket", "Round 2 winner"). Append-only: an undo marks
 * the latest entry `undone` rather than deleting it, and `Match.score` is
 * always the engine's replay of every entry with `undone: false`. That
 * makes "what actually happened" recoverable even after a correction, which
 * a delete-and-rewrite would not be.
 */
export const matchLogEntrySchema = z.object({
  id: idSchema,
  matchId: idSchema,
  festId: idSchema,
  eventId: idSchema,

  /** The engine action type this entry recorded — "goal", "wicket", "point", ... */
  type: z.string().trim().min(1).max(60),
  side: matchSideSchema.optional(),
  payload: z.record(z.string(), z.unknown()).optional(),

  /** Precomputed display text — "Goal", "Wicket", "Round 2 winner". */
  label: shortTextSchema,

  undone: z.boolean().default(false),

  at: z.coerce.date(),
  createdBy: idSchema,
  /** Denormalised for the volunteer-activity analytics — same convention as `Attendance.scannedByName`. */
  createdByName: shortTextSchema.optional(),
});

export type MatchLogEntry = z.infer<typeof matchLogEntrySchema>;

/** The entries a score should be replayed from — everything not undone, in order. */
export const activeLog = (entries: readonly MatchLogEntry[]): MatchLogEntry[] =>
  entries.filter((e) => !e.undone).sort((a, b) => a.at.getTime() - b.at.getTime());
