import { z } from "zod";
import { auditFieldsSchema, idSchema, longTextSchema, shortTextSchema } from "./common";

/**
 * The result sheet a super admin publishes once an event is over.
 *
 * There is exactly one per event, and its document id *is* the event id. That
 * makes publishing idempotent: re-uploading a corrected sheet updates the same
 * document instead of creating a rival set of winners.
 */

export const AWARD_TYPES = [
  "winner",
  "runner_up",
  "second_runner_up",
  "special_mention",
] as const;
export const awardTypeSchema = z.enum(AWARD_TYPES);
export type AwardType = z.infer<typeof awardTypeSchema>;

/** Ordinal position to award, for sheets that are uploaded as ranks. */
export const awardForPosition = (position: number): AwardType => {
  if (position === 1) return "winner";
  if (position === 2) return "runner_up";
  if (position === 3) return "second_runner_up";
  return "special_mention";
};

export const AWARD_LABELS: Record<AwardType, string> = {
  winner: "Winner",
  runner_up: "Runner-up",
  second_runner_up: "Second Runner-up",
  special_mention: "Special Mention",
};

export const resultEntrySchema = z.object({
  /** Identifies the winning entry. Must be a registration for this event. */
  registrationId: idSchema,
  /** 1-based rank. Ties are allowed: two entries may share a position. */
  position: z.number().int().min(1).max(100),
  award: awardTypeSchema,
  /** Denormalised so the results table renders without extra lookups. */
  displayName: shortTextSchema,
  note: longTextSchema.optional(),
});

export type ResultEntry = z.infer<typeof resultEntrySchema>;

export const RESULT_STATUSES = ["draft", "published"] as const;
export const resultStatusSchema = z.enum(RESULT_STATUSES);
export type ResultStatus = z.infer<typeof resultStatusSchema>;

export const resultSchema = z
  .object({
    /** Always equal to `eventId`. */
    id: idSchema,
    eventId: idSchema,
    festId: idSchema,

    entries: z.array(resultEntrySchema).max(100).default([]),

    /**
     * Certificates are only ever generated from a `published` sheet. Keeping
     * a draft state means a half-entered sheet cannot accidentally email a
     * few hundred students.
     */
    status: resultStatusSchema.default("draft"),

    publishedAt: z.date().optional(),
    publishedBy: idSchema.optional(),

    /** Set when a published sheet is saved again — shown as an amendment. */
    amendedAt: z.date().optional(),
    amendedBy: idSchema.optional(),

    /**
     * Set once the certificate run for this sheet has completed, so a repeat
     * publish does not silently re-send every email.
     */
    certificatesGeneratedAt: z.date().optional(),

    createdBy: idSchema,
  })
  .merge(auditFieldsSchema)
  .refine(
    (result) => {
      const ids = result.entries.map((entry) => entry.registrationId);
      return new Set(ids).size === ids.length;
    },
    { message: "The same entry is listed twice in the results", path: ["entries"] },
  );

export type Result = z.infer<typeof resultSchema>;

export const upsertResultSchema = z
  .object({
    eventId: idSchema,
    entries: z.array(resultEntrySchema).max(100).default([]),
    status: resultStatusSchema.default("draft"),
  })
  .refine(
    (result) => {
      const ids = result.entries.map((entry) => entry.registrationId);
      return new Set(ids).size === ids.length;
    },
    { message: "The same entry is listed twice in the results", path: ["entries"] },
  );

export type UpsertResult = z.infer<typeof upsertResultSchema>;
