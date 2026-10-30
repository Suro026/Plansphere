import type { AdmissionBlock } from "./admission";
import { z } from "zod";
import { auditFieldsSchema, emailSchema, idSchema, shortTextSchema } from "./common";

/**
 * Attendance is its own collection rather than a flag on the registration.
 *
 * A flag cannot answer "who scanned this, and when", cannot be extended to
 * multi-day events, and gives the scanner no way to detect a second scan
 * except by reading a value it also writes. A separate record with a
 * deterministic id makes a duplicate scan a write conflict rather than a
 * silent overwrite.
 */

/**
 * A member's key inside an entry.
 *
 * Attendance and meals are recorded per person — a team of four arrives in
 * twos and eats at different times — so every record needs to name *which*
 * member. The email is the stable identity (a member's index moves when the
 * leader edits the roster, and their uid may not exist yet), but an email is
 * not a legal document id, so it is folded into eight hex characters.
 *
 * FNV-1a: tiny, dependency-free, synchronous, and identical on the device and
 * the server — which matters, because the offline scanner computes these keys
 * with no network and the server must land on the same ones.
 */
export const memberKeyFor = (email: string): string => {
  const text = email.trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range without BigInt.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

export const ATTENDANCE_METHODS = ["qr", "manual"] as const;
export const attendanceMethodSchema = z.enum(ATTENDANCE_METHODS);
export type AttendanceMethod = z.infer<typeof attendanceMethodSchema>;

export const attendanceSchema = z
  .object({
    /** Always `${registrationId}` — one attendance record per entry. */
    id: idSchema,
    registrationId: idSchema,
    eventId: idSchema,
    festId: idSchema,
    userId: idSchema,

    /** Denormalised for the scanner's live feed and the attendance report. */
    userName: shortTextSchema,
    userEmail: emailSchema,
    ticketCode: shortTextSchema,
    teamName: shortTextSchema.optional(),

    /**
     * Who on the entry actually arrived.
     *
     * A team shares one QR and one attendance document, but its members turn
     * up separately: the leader is scanned in at 09:40 and two more arrive at
     * 10:15 on the same code. Each scan adds the members marked present and
     * leaves the rest alone, so this array only ever grows — which is also
     * what the Firestore rules enforce, because a scanner that could shorten
     * it could un-attend someone.
     *
     * Empty on records written before per-member marking, which read as
     * "everyone on the entry" — that is what those scans meant.
     */
    members: z
      .array(
        z.object({
          /** `memberKeyFor(email)`. */
          key: shortTextSchema,
          name: shortTextSchema,
          email: emailSchema,
          at: z.coerce.date(),
          /** uid of the volunteer who marked this person. */
          by: idSchema.optional(),
        }),
      )
      .default([]),
    /** Members on the entry at the time of the first scan. */
    memberCount: z.number().int().min(1).default(1),

    method: attendanceMethodSchema.default("qr"),
    /** Which gate the scan happened at, from the volunteer's post. */
    gate: shortTextSchema.optional(),
    scannedAt: z.date(),
    /** uid of the organizer who performed the scan. */
    scannedBy: idSchema,
    /** Display name at scan time, so "By Rohit · Gate B" needs no lookup. */
    scannedByName: shortTextSchema.optional(),
    /** Set when the scan was taken offline and synced later. */
    queuedOffline: z.boolean().default(false),
  })
  .merge(auditFieldsSchema);

export type Attendance = z.infer<typeof attendanceSchema>;

/**
 * The deterministic attendance document id for an entry.
 *
 * Because the id is derived rather than generated, a create-if-absent write
 * fails on the second scan instead of overwriting the first. That is what
 * makes the "already scanned" message in the scanner truthful.
 */
export const attendanceIdFor = (registrationId: string): string => registrationId;

/**
 * Which members of an entry are still to arrive.
 *
 * The scanner shows this on every scan of the same code: the ones already
 * ticked are shown ticked and cannot be un-ticked, and only the rest are
 * offered. An attendance record with no `members` array predates per-member
 * marking and counts as everyone present.
 */
export const presentKeys = (attendance: Pick<Attendance, "members"> | null | undefined): Set<string> =>
  new Set((attendance?.members ?? []).map((member) => member.key));

export const isFullyPresent = (
  attendance: Pick<Attendance, "members"> | null | undefined,
  members: readonly { email: string }[],
): boolean => {
  if (!attendance) return false;
  // A legacy record marked the whole entry.
  if ((attendance.members ?? []).length === 0) return true;
  const present = presentKeys(attendance);
  return members.every((member) => present.has(memberKeyFor(member.email)));
};

/** Meals are tracked per slot so a two-day fest can hand out six meals. */
export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;
export const mealTypeSchema = z.enum(MEAL_TYPES);
export type MealType = z.infer<typeof mealTypeSchema>;

export const foodCollectionSchema = z
  .object({
    /** `${registrationId}_${date}_${mealType}`. See `foodCollectionIdFor`. */
    id: idSchema,
    registrationId: idSchema,
    eventId: idSchema,
    festId: idSchema,
    userId: idSchema,

    userName: shortTextSchema,
    ticketCode: shortTextSchema,
    teamName: shortTextSchema.optional(),

    mealType: mealTypeSchema,
    /** `YYYY-MM-DD` of the day the meal belongs to. */
    servedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

    /** Which of the entry's servings this is, 1..memberCount. */
    serving: z.number().int().min(1).default(1),
    /**
     * The member this serving went to — `memberKeyFor(email)`.
     *
     * Absent on records written before per-member meals, which were counted
     * rather than named. Present ones are what make "this person already had
     * lunch" a write conflict instead of a count comparison.
     */
    memberKey: shortTextSchema.optional(),
    memberName: shortTextSchema.optional(),
    /** The counter it was served from. */
    post: shortTextSchema.optional(),
    collectedAt: z.date(),
    collectedBy: idSchema,
    collectedByName: shortTextSchema.optional(),
    queuedOffline: z.boolean().default(false),
  })
  .merge(auditFieldsSchema);

export type FoodCollection = z.infer<typeof foodCollectionSchema>;

/**
 * One meal, per person, per slot, per day. Encoding all three in the id is
 * what stops a participant from collecting lunch twice, and it does so with a
 * write constraint rather than a read-then-check that two scanners could race
 * through simultaneously.
 */
export const foodCollectionIdFor = (
  registrationId: string,
  servedOn: string,
  mealType: MealType,
  /**
   * The member's key, or a 1-based serving index for the pre-member scheme.
   *
   * Both forms live in the same collection and cannot collide: a member key
   * is eight hex characters, a serving index is a small decimal. Old records
   * keep working and keep counting.
   */
  member: string | number = 1,
): string => `${registrationId}_${servedOn}_${mealType}_${member}`;

/** The id for one member's serving of one meal round. */
export const mealIdForMember = (
  registrationId: string,
  servedOn: string,
  mealType: MealType,
  email: string,
): string => foodCollectionIdFor(registrationId, servedOn, mealType, memberKeyFor(email));

/** One person on an entry, as the scanner shows them. */
export interface ScanMember {
  key: string;
  name: string;
  email: string;
  /** Already marked — shown ticked, and not offered again. */
  done: boolean;
  /** When they were marked, for the ones already done. */
  at?: Date | undefined;
}

/** What the scanner screens receive after a successful or rejected scan. */
export type ScanOutcome =
  | {
      result: "ok";
      registration: { id: string; userName: string; ticketCode: string; teamName?: string; memberCount: number };
      /** True when the scan was accepted locally and is waiting to sync. */
      queued?: boolean;
      /** Meals: which serving this was, of how many. */
      serving?: { n: number; of: number };
      /** Who was marked by this scan. */
      marked?: string[];
      /** The whole roster for this entry, with what is already done. */
      members?: ScanMember[];
    }
  | {
      result: "already-recorded";
      at: Date;
      by?: string;
      /**
       * Present even on a duplicate: a team arriving in twos scans the same
       * code again, and the screen has to show who is still outstanding
       * rather than a flat "already checked in".
       */
      members?: ScanMember[];
      registration?: { id: string; userName: string; ticketCode: string; teamName?: string; memberCount: number };
    }
  | { result: "not-found" }
  | { result: "wrong-event"; expectedEventTitle: string }
  | { result: "cancelled" }
  /** On the waitlist: no seat is held, so nobody is admitted or served. */
  | { result: "waitlisted" }
  /** A team that has not reached its minimum size: not an entry yet, so nobody is admitted or served. */
  | { result: "draft" }
  /** A paid entry whose payment has not been verified: not admitted, not served. */
  | { result: "unpaid" };

/** The scan result a refused admission is reported as. A returned payment reads as cancelled. */
export const blockOutcome = (block: AdmissionBlock): { result: "cancelled" | "waitlisted" | "draft" | "unpaid" } =>
  block === "waitlisted" ? { result: "waitlisted" } : block === "draft" ? { result: "draft" } : block === "unpaid" ? { result: "unpaid" } : { result: "cancelled" };
