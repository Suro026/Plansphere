import { z } from "zod";
import {
  auditFieldsSchema,
  calendarDateSchema,
  clockTimeSchema,
  emailSchema,
  idSchema,
  longTextSchema,
  shortTextSchema,
} from "./common";

/**
 * A volunteer shift: one person, one post, one window.
 *
 * Volunteers are not a role. They are organizer accounts — the lowest staff
 * role — rostered here by post and duty. That is what the design settled on
 * ("one account, managed where the work is"), and it means the scanner's
 * permission check is simply "is an organizer scoped to this fest", with the
 * shift telling the app *where* and *what* rather than *whether*.
 */

export const SHIFT_DUTIES = ["entry", "meal", "crowd", "scoring"] as const;
export const shiftDutySchema = z.enum(SHIFT_DUTIES);
export type ShiftDuty = z.infer<typeof shiftDutySchema>;

export const SHIFT_DUTY_LABELS: Record<ShiftDuty, string> = {
  entry: "Entry scanning",
  meal: "Meal scanning",
  crowd: "Crowd & help desk",
  scoring: "Live scoring",
};

/**
 * For a `scoring` shift, `post` holds the arena's document id rather than a
 * free-text label — the live scorer's permission check (`requireArenaAccess`
 * in `server/live.ts`) matches it against the match's `arenaId` directly,
 * the same way every other duty already uses `post` to say *where*.
 */

export const shiftSchema = z
  .object({
    id: idSchema,
    festId: idSchema,

    userId: idSchema,
    /** Denormalised for the roster table. */
    userName: shortTextSchema,
    userEmail: emailSchema,

    /** "Gate A", "Food counter 1", "Open Air Theatre". */
    post: shortTextSchema,
    duty: shiftDutySchema,

    date: calendarDateSchema,
    startTime: clockTimeSchema,
    endTime: clockTimeSchema,

    /** Events this shift may scan for. Empty means the whole fest. */
    eventIds: z.array(idSchema).max(50).default([]),

    coordinatorName: shortTextSchema.optional(),
    notes: longTextSchema.optional(),

    cancelled: z.boolean().default(false),

    createdBy: idSchema,
  })
  .merge(auditFieldsSchema);

export type Shift = z.infer<typeof shiftSchema>;

export const createShiftSchema = z.object({
  festId: idSchema,
  userId: idSchema,
  post: shortTextSchema,
  duty: shiftDutySchema,
  date: calendarDateSchema,
  startTime: clockTimeSchema,
  endTime: clockTimeSchema,
  eventIds: z.array(idSchema).max(50).default([]),
  coordinatorName: shortTextSchema.optional(),
  notes: longTextSchema.optional(),
});

export type CreateShift = z.infer<typeof createShiftSchema>;

export const updateShiftSchema = createShiftSchema.omit({ festId: true, userId: true }).partial().extend({
  cancelled: z.boolean().optional(),
});

export type UpdateShift = z.infer<typeof updateShiftSchema>;

/** Where a shift sits relative to now, for the "On shift · Upcoming · Completed" tags. */
export type ShiftPhase = "upcoming" | "active" | "completed" | "cancelled";

export const shiftPhase = (shift: Shift, now: Date = new Date()): ShiftPhase => {
  if (shift.cancelled) return "cancelled";
  const start = new Date(`${shift.date}T${shift.startTime}:00`);
  const end = new Date(`${shift.date}T${shift.endTime}:00`);
  if (now < start) return "upcoming";
  if (now > end) return "completed";
  return "active";
};

/** `3h 19m` until the shift ends, or null once it has. */
export const shiftRemaining = (shift: Shift, now: Date = new Date()): string | null => {
  const end = new Date(`${shift.date}T${shift.endTime}:00`);
  const ms = end.getTime() - now.getTime();
  if (ms <= 0) return null;
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
};
