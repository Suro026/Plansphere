import { z } from "zod";
import {
  auditFieldsSchema,
  calendarDateSchema,
  clockTimeSchema,
  idSchema,
  longTextSchema,
  shortTextSchema, httpsUrlSchema } from "./common";
import { registrationFieldsSchema } from "./registration-fields";
import { matchConfigSchema, sportTypeSchema, tournamentTypeSchema } from "./match";

export const EVENT_TYPES = ["solo", "team"] as const;
export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;

/**
 * The built-in categories offered in the picker. Not a closed set: an admin
 * types anything they like and it is stored as given (lowercased, for
 * consistent filtering) — `categoryLabel()` below is what turns either kind
 * back into a display string.
 */
export const EVENT_CATEGORIES = [
  "technical",
  "cultural",
  "sports",
  "hackathon",
  "workshop",
  "seminar",
  "conference",
  "esports",
  "other",
] as const;
/** Still exported for anywhere a built-in value is asserted against. */
export const eventCategorySchema = z.enum(EVENT_CATEGORIES);
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

/** A free-text category, normalised to lowercase so filtering is exact-match. */
export const eventCategoryValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .toLowerCase();

const CATEGORY_LABELS: Record<EventCategory, string> = {
  technical: "Technical",
  cultural: "Cultural",
  sports: "Sports",
  hackathon: "Hackathon",
  workshop: "Workshop",
  seminar: "Seminar",
  conference: "Conference",
  esports: "Esports",
  other: "Other",
};

/** "gaming" was the old name for "esports"; existing data reads under it. */
const LEGACY_CATEGORY_LABELS: Record<string, string> = { gaming: "Esports" };

/** The label for a category, built-in or custom. */
export const categoryLabel = (category: string): string =>
  CATEGORY_LABELS[category as EventCategory] ??
  LEGACY_CATEGORY_LABELS[category] ??
  (category.length ? category[0]!.toUpperCase() + category.slice(1) : "Event");

export const EVENT_STATUSES = ["draft", "published", "ongoing", "completed", "cancelled"] as const;
export const eventStatusSchema = z.enum(EVENT_STATUSES);
export type EventStatus = z.infer<typeof eventStatusSchema>;

/**
 * Team size bounds. For a solo event both are 1, which lets registration
 * validation treat solo and team events through the same code path instead of
 * branching on `eventType` everywhere.
 */
export const teamSizeSchema = z
  .object({
    min: z.number().int().min(1).max(50),
    max: z.number().int().min(1).max(50),
  })
  .refine((size) => size.max >= size.min, {
    message: "Maximum team size cannot be smaller than the minimum",
    path: ["max"],
  });

export type TeamSize = z.infer<typeof teamSizeSchema>;

export const coordinatorSchema = z.object({
  name: shortTextSchema,
  phone: z.string().trim().max(20).optional(),
  email: z.string().email().optional(),
});

export type Coordinator = z.infer<typeof coordinatorSchema>;

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens");

/**
 * A named meal slot — "Day 1 lunch". Meals are tracked per slot rather than
 * as one boolean, so a two-day fest can hand out six meals and refuse a
 * second helping of any one of them.
 */
export const MEAL_TYPES_LIST = ["breakfast", "lunch", "dinner", "snack"] as const;

export const mealSlotSchema = z.object({
  /** `YYYY-MM-DD` */
  date: calendarDateSchema,
  mealType: z.enum(MEAL_TYPES_LIST),
  label: shortTextSchema,
});

export type MealSlot = z.infer<typeof mealSlotSchema>;

export const eventSchema = z
  .object({
    id: idSchema,
    festId: idSchema,
    /** URL segment under the fest: `/f/{fest}/e/{slug}`. Unique within a fest. */
    slug: slugSchema,

    title: shortTextSchema,
    description: longTextSchema.optional(),
    category: eventCategoryValueSchema.default("other"),
    visibility: z.enum(["public", "unlisted", "archived"]).default("public"),

    eventType: eventTypeSchema.default("solo"),
    teamSize: teamSizeSchema.default({ min: 1, max: 1 }),

    date: calendarDateSchema,
    startTime: clockTimeSchema,
    endTime: clockTimeSchema.optional(),
    venue: shortTextSchema,

    /** 0 means unlimited. */
    capacity: z.number().int().min(0).max(100000).default(0),

    /**
     * Maintained by the data layer inside the same transaction that writes a
     * registration, so a capacity check never races against a concurrent
     * sign-up.
     */
    registeredCount: z.number().int().min(0).default(0),

    registrationOpen: z.boolean().default(true),
    registrationDeadline: calendarDateSchema.optional(),
    /** Registrations beyond capacity queue here instead of being refused. */
    waitlistEnabled: z.boolean().default(false),

    /** In rupees. 0 is free entry. */
    entryFee: z.number().int().min(0).max(1000000).default(0),

    posterUrl: httpsUrlSchema.optional(),
    /** The rulebook PDF, uploaded like any other asset — see `uploadKind`. */
    rulebookUrl: httpsUrlSchema.optional(),
    rules: z.array(z.string().trim().max(500)).max(50).default([]),
    /** A short free-text summary — "₹50,000 across 3 places". Line items stay in `prizes`. */
    prizePool: shortTextSchema.optional(),
    prizes: z.array(z.string().trim().max(200)).max(20).default([]),
    coordinators: z.array(coordinatorSchema).max(10).default([]),

    /** Named entry points the scanner can be posted at. */
    gates: z.array(shortTextSchema).max(20).default([]),
    mealSlots: z.array(mealSlotSchema).max(30).default([]),

    status: eventStatusSchema.default("draft"),

    /**
     * What this event asks its students for, on top of the fest's own
     * defaults. Absent means "just the fest's questions" — an event does not
     * have to configure anything to inherit a sensible form. See
     * `core/models/registration-fields.ts` for how the two are merged.
     */
    registrationFields: z.lazy(() => registrationFieldsSchema).optional(),

    /**
     * Live Event Engine — off by default. An event with `liveEnabled` gets a
     * public `/live/[slug]` page, a bracket, and a volunteer scorer; one
     * without is unaffected by any of it. `sportType` is free text (an admin
     * can type anything the picker doesn't offer) matched by the scoring
     * engine registry in `core/services/scoring`.
     */
    liveEnabled: z.boolean().default(false),
    tournamentType: tournamentTypeSchema.optional(),
    sportType: sportTypeSchema.optional(),
    matchConfig: matchConfigSchema.optional(),

    /**
     * Set once results are published. The certificate pipeline reads this to
     * know an event is finished and eligibility can be computed.
     */
    resultsPublishedAt: z.date().optional(),

    archivedAt: z.coerce.date().optional(),

    createdBy: idSchema,
  })
  .merge(auditFieldsSchema);

export type Event = z.infer<typeof eventSchema>;

/** True when a student is allowed to register right now. */
export const isRegistrationOpen = (
  event: Pick<
    Event,
    "registrationOpen" | "registrationDeadline" | "capacity" | "registeredCount" | "status"
  >,
  now: Date = new Date(),
): boolean => {
  if (!event.registrationOpen) return false;
  if (event.status !== "published" && event.status !== "ongoing") return false;
  if (event.capacity > 0 && event.registeredCount >= event.capacity) return false;

  if (event.registrationDeadline) {
    // The deadline is a calendar date, so it stays open through that whole day.
    const endOfDeadline = new Date(`${event.registrationDeadline}T23:59:59`);
    if (now > endOfDeadline) return false;
  }

  return true;
};

export const isEventFull = (event: Pick<Event, "capacity" | "registeredCount">): boolean =>
  event.capacity > 0 && event.registeredCount >= event.capacity;

export const seatsRemaining = (
  event: Pick<Event, "capacity" | "registeredCount">,
): number | null => (event.capacity > 0 ? Math.max(0, event.capacity - event.registeredCount) : null);

const eventWritableFields = {
  slug: slugSchema,
  title: shortTextSchema,
  description: longTextSchema.optional(),
  category: eventCategoryValueSchema.default("other"),
  visibility: z.enum(["public", "unlisted", "archived"]).default("public"),
  eventType: eventTypeSchema.default("solo"),
  teamSize: teamSizeSchema.default({ min: 1, max: 1 }),
  date: calendarDateSchema,
  startTime: clockTimeSchema,
  endTime: clockTimeSchema.optional(),
  venue: shortTextSchema,
  capacity: z.number().int().min(0).max(100000).default(0),
  registrationOpen: z.boolean().default(true),
  registrationDeadline: calendarDateSchema.optional(),
  waitlistEnabled: z.boolean().default(false),
  entryFee: z.number().int().min(0).max(1000000).default(0),
  posterUrl: httpsUrlSchema.optional(),
  rulebookUrl: httpsUrlSchema.optional(),
  rules: z.array(z.string().trim().max(500)).max(50).default([]),
  prizePool: shortTextSchema.optional(),
  prizes: z.array(z.string().trim().max(200)).max(20).default([]),
  coordinators: z.array(coordinatorSchema).max(10).default([]),
  gates: z.array(shortTextSchema).max(20).default([]),
  mealSlots: z.array(mealSlotSchema).max(30).default([]),
  status: eventStatusSchema.default("draft"),
  registrationFields: z.lazy(() => registrationFieldsSchema).optional(),
  liveEnabled: z.boolean().default(false),
  tournamentType: tournamentTypeSchema.optional(),
  sportType: sportTypeSchema.optional(),
  matchConfig: matchConfigSchema.optional(),
};

/**
 * A team event must allow more than one member, otherwise the registration
 * form renders a team flow that can only ever accept a single person.
 */
const consistentTeamSize = <T extends { eventType: EventType; teamSize: TeamSize }>(
  value: T,
  ctx: z.RefinementCtx,
) => {
  if (value.eventType === "team" && value.teamSize.max < 2) {
    ctx.addIssue({
      code: "custom",
      message: "A team event needs a maximum team size of at least 2",
      path: ["teamSize", "max"],
    });
  }

  if (value.eventType === "solo" && (value.teamSize.min !== 1 || value.teamSize.max !== 1)) {
    ctx.addIssue({
      code: "custom",
      message: "A solo event must have a team size of exactly 1",
      path: ["teamSize"],
    });
  }
};

export const createEventSchema = z
  .object({ festId: idSchema, ...eventWritableFields })
  .superRefine(consistentTeamSize);

export type CreateEvent = z.infer<typeof createEventSchema>;

/**
 * An update names only what it changes. `.partial()` alone is not enough: in
 * Zod 4 a field's `.default()` still fires when the key is missing, so a
 * `{ status: "completed" }` body would be parsed into capacity 0, no rules, no
 * meals, a 1–1 team size — and quietly overwrite the event with them. The
 * defaults are stripped here so a missing key stays missing.
 */
const withoutDefaults = <T extends z.ZodRawShape>(shape: T): T =>
  Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, field instanceof z.ZodDefault ? field.unwrap() : field])) as unknown as T;

export const updateEventSchema = z.object(withoutDefaults(eventWritableFields)).partial();

export type UpdateEvent = z.infer<typeof updateEventSchema>;

/**
 * Duplicating an event copies its shape, not its history: no attendees, no
 * counter, a fresh slug, and it always lands as a draft so the coordinator
 * reviews it before anyone can register.
 */
export const duplicateEventFrom = (event: Event, newSlug: string): CreateEvent => ({
  festId: event.festId,
  slug: newSlug,
  title: `${event.title} (copy)`,
  description: event.description,
  category: event.category,
  visibility: "public",
  eventType: event.eventType,
  teamSize: event.teamSize,
  date: event.date,
  startTime: event.startTime,
  endTime: event.endTime,
  venue: event.venue,
  capacity: event.capacity,
  registrationOpen: false,
  registrationDeadline: event.registrationDeadline,
  waitlistEnabled: event.waitlistEnabled,
  entryFee: event.entryFee,
  posterUrl: event.posterUrl,
  rulebookUrl: event.rulebookUrl,
  rules: event.rules,
  prizePool: event.prizePool,
  prizes: event.prizes,
  coordinators: event.coordinators,
  gates: event.gates,
  mealSlots: event.mealSlots,
  status: "draft",
  registrationFields: event.registrationFields,
  // The rulebook carries over — the copy is very likely the same sport —
  // but not `liveEnabled`: a fresh event has no bracket or matches yet, and
  // turning live mode on is a deliberate step the coordinator takes once
  // registrations exist to generate one from.
  liveEnabled: false,
  tournamentType: event.tournamentType,
  sportType: event.sportType,
  matchConfig: event.matchConfig,
});

/* ───────────── scheduling conflicts ───────────── */

export interface ScheduleConflict {
  eventId: string;
  eventTitle: string;
  reason: "venue" | "coordinator" | "overlap";
  detail: string;
}

const toRange = (event: Pick<Event, "date" | "startTime" | "endTime">): [number, number] => {
  const start = new Date(`${event.date}T${event.startTime}:00`).getTime();
  const end = new Date(`${event.date}T${event.endTime ?? "23:59"}:00`).getTime();
  return [start, Number.isFinite(end) && end > start ? end : start + 60 * 60 * 1000];
};

const overlaps = (a: [number, number], b: [number, number]): boolean => a[0] < b[1] && b[0] < a[1];

/**
 * Warns before a save, never blocks one: a fest legitimately runs two
 * simultaneous events at different venues, and a coordinator legitimately
 * runs two events back to back. What is worth a warning is the same venue or
 * the same coordinator double-booked for overlapping time — a schedule a
 * human should look at before it goes out, not a rule that could be wrong
 * about someone's actual plan.
 */
export const detectScheduleConflicts = (
  candidate: Pick<Event, "date" | "startTime" | "endTime" | "venue" | "coordinators"> & { id?: string },
  others: readonly Pick<Event, "id" | "title" | "date" | "startTime" | "endTime" | "venue" | "coordinators" | "status">[],
): ScheduleConflict[] => {
  if (candidate.date === "" || !candidate.startTime) return [];
  const range = toRange(candidate);
  const conflicts: ScheduleConflict[] = [];

  for (const other of others) {
    if (other.id === candidate.id) continue;
    if (other.status === "cancelled") continue;
    if (other.date !== candidate.date) continue;
    if (!overlaps(range, toRange(other))) continue;

    if (other.venue.trim().toLowerCase() === candidate.venue.trim().toLowerCase()) {
      conflicts.push({ eventId: other.id, eventTitle: other.title, reason: "venue", detail: `${other.title} is also at ${other.venue} at an overlapping time.` });
    }

    const names = new Set(candidate.coordinators.map((c) => c.name.trim().toLowerCase()));
    const shared = other.coordinators.find((c) => names.has(c.name.trim().toLowerCase()));
    if (shared) {
      conflicts.push({ eventId: other.id, eventTitle: other.title, reason: "coordinator", detail: `${shared.name} is also coordinating ${other.title} at an overlapping time.` });
    }
  }

  return conflicts;
};
