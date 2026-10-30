import { z } from "zod";
import {
  auditFieldsSchema,
  calendarDateSchema,
  emailSchema,
  idSchema,
  longTextSchema,
  phoneSchema,
  shortTextSchema, httpsUrlSchema, optionalHttpsUrlSchema } from "./common";
import { registrationFieldsSchema } from "./registration-fields";

/**
 * A fest is the top-level container. Events belong to exactly one fest, and
 * an organizer's access is scoped by fest id.
 */

export const FEST_STATUSES = ["draft", "published", "archived"] as const;
export const festStatusSchema = z.enum(FEST_STATUSES);
export type FestStatus = z.infer<typeof festStatusSchema>;

/**
 * Review of a self-service application: `pending` → `approved` | `rejected`. Only an approval makes the applicant the
 * fest's Event Head; until then they hold no authority over it.
 */
export const VERIFICATION_STATUSES = ["pending", "approved", "rejected"] as const;
export const verificationStatusSchema = z.enum(VERIFICATION_STATUSES);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

export const festVerificationSchema = z.object({
  status: verificationStatusSchema,
  submittedAt: z.coerce.date(),
  decidedAt: z.coerce.date().optional(),
  /** `review`: a platform reviewer decided. `platform`: created by the platform itself, so there was nothing to review. */
  basis: z.enum(["review", "platform"]).optional(),
});
export type FestVerification = z.infer<typeof festVerificationSchema>;

/**
 * Where a fest stands in review. A fest with no `verification` predates the review step: it is neither verified nor
 * under review, and nothing about how it works changes. Callers must not read "legacy" as "approved".
 */
export const festVerificationState = (fest: { verification?: { status: VerificationStatus } | undefined }): VerificationStatus | "legacy" =>
  fest.verification?.status ?? "legacy";

/** A fest still under review, or turned down, must not go public. Legacy and approved fests are unaffected. */
export const festMayBePublished = (fest: { verification?: { status: VerificationStatus } | undefined }): boolean => {
  const state = festVerificationState(fest);
  return state !== "pending" && state !== "rejected";
};

/** What kind of fest this is. Drives the explorer filter and the default artwork. */
export const FEST_TYPES = ["tech", "cultural", "sports", "hackathon", "conference", "other"] as const;
export const festTypeSchema = z.enum(FEST_TYPES);
export type FestType = z.infer<typeof festTypeSchema>;

export const FEST_TYPE_LABELS: Record<FestType, string> = {
  tech: "Tech fest",
  cultural: "Cultural fest",
  sports: "Sports fest",
  hackathon: "Hackathon",
  conference: "Conference",
  other: "Other",
};

/** What kind of organization is registering the event — collected at self-service registration. */
export const ORGANIZATION_TYPES = ["college", "university", "conference", "club", "company", "ngo"] as const;
export const organizationTypeSchema = z.enum(ORGANIZATION_TYPES);
export type OrganizationType = z.infer<typeof organizationTypeSchema>;

export const ORGANIZATION_TYPE_LABELS: Record<OrganizationType, string> = {
  college: "College",
  university: "University",
  conference: "Conference",
  club: "Club",
  company: "Company",
  ngo: "NGO",
};

/**
 * The person who registered the event — collected once, at registration, and
 * kept on the fest for accountability. Distinct from their `users` profile:
 * this is who they said they were *for this event*, not their account.
 */
export const eventHeadSchema = z.object({
  name: shortTextSchema,
  designation: shortTextSchema,
  phone: phoneSchema,
  /**
   * Legacy: a link typed or pasted in. Superseded by `idDocumentPath` for new applications, which names the private upload.
   * Never trusted as evidence on its own - a reviewer opens the uploaded file, not whatever this points at.
   */
  idCardUrl: optionalHttpsUrlSchema,
  /**
   * The private upload (`POST /api/uploads?kind=eventHeadIdentity`) holding the ID card or authorization letter that
   * shows this person may register on the organization's behalf: `users/{uid}/identity/{random}.{ext}`, in the private
   * `uploads` bucket. A path, never a URL: a link into a private bucket expires, and the reviewer asks the server for a
   * fresh short-lived one. The server refuses a path that does not sit under the caller's own folder.
   */
  idDocumentPath: z
    .string()
    .regex(/^users\/[A-Za-z0-9_-]{1,128}\/identity\/[A-Za-z0-9_-]{1,64}\.(png|jpg|webp|gif|pdf)$/, "That is not an uploaded identity document.")
    .optional(),
  linkedin: optionalHttpsUrlSchema,
});

export type EventHead = z.infer<typeof eventHeadSchema>;

/**
 * Who can find the fest, as distinct from whether it is published.
 *
 *   public   — listed in the explorer and indexed
 *   unlisted — reachable at its address, never listed (a soft launch)
 *   private  — staff only, whatever the status says
 */
export const FEST_VISIBILITIES = ["public", "unlisted", "private"] as const;
export const festVisibilitySchema = z.enum(FEST_VISIBILITIES);
export type FestVisibility = z.infer<typeof festVisibilitySchema>;

/**
 * The fest-wide registration switch. Individual events keep their own
 * `registrationOpen`; this one closes all of them at once, which is what a
 * fest needs on the morning it starts.
 */
export const FEST_REGISTRATION_STATES = ["open", "closed", "upcoming"] as const;
export const festRegistrationStateSchema = z.enum(FEST_REGISTRATION_STATES);
export type FestRegistrationState = z.infer<typeof festRegistrationStateSchema>;

/** #rrggbb, used for the fest's accent on its public page. */
export const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #9184d9");

/** "2025-26". Free enough for institutions that write it differently. */
export const academicYearSchema = z
  .string()
  .trim()
  .max(12)
  .regex(/^[0-9]{4}(-[0-9]{2,4})?$/, "Use a year like 2025-26");

export const festSchema = z
  .object({
    id: idSchema,
    name: shortTextSchema,
    /** URL-safe identifier used for public fest pages. Unique across fests. */
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(60)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens"),
    tagline: shortTextSchema.optional(),
    description: longTextSchema.optional(),

    organizationName: shortTextSchema,
    /** Absent on fests created before self-service registration. */
    organizationType: organizationTypeSchema.optional(),
    organizationWebsite: httpsUrlSchema.optional(),
    venue: shortTextSchema,
    /** City the fest is held in — the explorer's primary filter. */
    city: shortTextSchema,
    state: shortTextSchema.optional(),
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,

    /** What kind of fest. Older documents predate the field. */
    festType: festTypeSchema.default("other"),
    academicYear: academicYearSchema.optional(),
    themeColor: hexColorSchema.optional(),
    expectedParticipants: z.number().int().min(1).max(1_000_000).optional(),
    /*
     * There is deliberately no `eventHead` here. A published fest is readable by anyone, signed in or not, and Firestore
     * rules cannot hide a field, so the Event Head's phone number, LinkedIn address and ID-document reference live in the
     * server-only `festPrivate/{festId}` document instead (see `register-event/route.ts`).
     */

    bannerUrl: httpsUrlSchema.optional(),
    logoUrl: httpsUrlSchema.optional(),
    /** The tall artwork at the top of the public fest page. */
    heroUrl: httpsUrlSchema.optional(),
    /** Square-ish card art for the explorer grid. */
    thumbnailUrl: httpsUrlSchema.optional(),
    /** 1200x630 for link previews. Falls back to the banner. */
    socialImageUrl: httpsUrlSchema.optional(),

    visibility: festVisibilitySchema.default("public"),
    registrationState: festRegistrationStateSchema.default("open"),

    /**
     * What this fest asks its students for. Absent on fests created before
     * the field existed, which `visibleFields` reads as the default set.
     */
    registrationFields: registrationFieldsSchema.optional(),

    /**
     * Only `published` fests appear in the student-facing explorer. Students
     * are blocked from reading drafts by the Firestore rules, not just by the
     * query.
     */
    status: festStatusSchema.default("draft"),

    contactEmail: z.string().email().optional(),
    contactPhone: z.string().max(20).optional(),

    /**
     * Public counters, maintained by the code paths that change them (event
     * creation, the registration transaction, check-in). Registrations are
     * not publicly listable - a student's entry is theirs - so the marquee's
     * "6,412 registered" has to come from here rather than from a count.
     */
    stats: z
      .object({
        events: z.number().int().min(0).default(0),
        registrations: z.number().int().min(0).default(0),
        checkIns: z.number().int().min(0).default(0),
      })
      .default({ events: 0, registrations: 0, checkIns: 0 }),

    createdBy: idSchema,
    /**
     * The admin accountable for the fest. Distinct from `createdBy`, which is
     * historical and never changes; ownership transfers.
     */
    ownerId: idSchema.optional(),
    /**
     * Where a self-service application stands: `pending` until a platform reviewer decides, then `approved` or
     * `rejected`. Distinct from `status`, which is only about publication. Written by the server alone (the rules
     * refuse a client write to it), so an admin cannot mark their own fest verified.
     *
     * Absent on every fest that predates the review step. Those are "legacy": they keep working exactly as before and
     * are NOT treated as verified - see `festVerificationState`. Their reason and reviewer live in `festPrivate`.
     */
    verification: festVerificationSchema.optional(),
    archivedAt: z.coerce.date().optional(),
  })
  .merge(auditFieldsSchema)
  .refine((fest) => fest.endDate >= fest.startDate, {
    message: "The end date cannot be before the start date",
    path: ["endDate"],
  });

export type Fest = z.infer<typeof festSchema>;

/** Fields accepted when creating a fest. Server fills in the rest. */
export const createFestSchema = z
  .object({
    name: shortTextSchema,
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .min(2)
      .max(60)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and hyphens"),
    tagline: shortTextSchema.optional(),
    description: longTextSchema.optional(),
    organizationName: shortTextSchema,
    venue: shortTextSchema,
    city: shortTextSchema,
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    festType: festTypeSchema.default("other"),
    academicYear: academicYearSchema.optional(),
    themeColor: hexColorSchema.optional(),
    bannerUrl: httpsUrlSchema.optional(),
    logoUrl: httpsUrlSchema.optional(),
    heroUrl: httpsUrlSchema.optional(),
    thumbnailUrl: httpsUrlSchema.optional(),
    socialImageUrl: httpsUrlSchema.optional(),
    visibility: festVisibilitySchema.default("public"),
    registrationState: festRegistrationStateSchema.default("open"),
    contactEmail: z.string().email().optional(),
    contactPhone: z.string().max(20).optional(),
  })
  .refine((fest) => fest.endDate >= fest.startDate, {
    message: "The end date cannot be before the start date",
    path: ["endDate"],
  });

export type CreateFest = z.infer<typeof createFestSchema>;

/**
 * Public self-service event registration — `POST /api/register-event`.
 *
 * The three-step wizard's whole shape: organization, event, event head.
 * Everything here lands directly on the `Fest` document (see the field
 * comments above) — there is no separate "registration request" record and
 * no review step between submitting this and the fest existing.
 */
export const registerEventSchema = z
  .object({
    // Step 1 — organization
    organizationName: shortTextSchema,
    organizationType: organizationTypeSchema,
    organizationWebsite: optionalHttpsUrlSchema,
    contactEmail: emailSchema,
    city: shortTextSchema,
    state: shortTextSchema,

    // Step 2 — event
    name: shortTextSchema,
    festType: festTypeSchema,
    startDate: calendarDateSchema,
    endDate: calendarDateSchema,
    venue: shortTextSchema,
    expectedParticipants: z.coerce.number().int().min(1, "Enter at least 1").max(1_000_000),
    description: longTextSchema.optional(),

    // Step 3 — event head
    eventHead: eventHeadSchema,
  })
  .refine((fest) => fest.endDate >= fest.startDate, {
    message: "The end date cannot be before the start date",
    path: ["endDate"],
  });

export type RegisterEvent = z.output<typeof registerEventSchema>;
/** Pre-validation shape — what the wizard's form actually holds (e.g. `expectedParticipants` as a string before it's coerced). */
export type RegisterEventInput = z.input<typeof registerEventSchema>;

/**
 * Partial update. `slug` is intentionally absent: changing it would break
 * every link already shared for the fest.
 */
export const updateFestSchema = z.object({
  name: shortTextSchema.optional(),
  tagline: shortTextSchema.optional(),
  description: longTextSchema.optional(),
  organizationName: shortTextSchema.optional(),
  venue: shortTextSchema.optional(),
  city: shortTextSchema.optional(),
  startDate: calendarDateSchema.optional(),
  endDate: calendarDateSchema.optional(),
  festType: festTypeSchema.optional(),
  academicYear: academicYearSchema.optional(),
  themeColor: hexColorSchema.optional(),
  bannerUrl: httpsUrlSchema.optional(),
  logoUrl: httpsUrlSchema.optional(),
  heroUrl: httpsUrlSchema.optional(),
  thumbnailUrl: httpsUrlSchema.optional(),
  socialImageUrl: httpsUrlSchema.optional(),
  visibility: festVisibilitySchema.optional(),
  registrationState: festRegistrationStateSchema.optional(),
  status: festStatusSchema.optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(20).optional(),
});

export type UpdateFest = z.infer<typeof updateFestSchema>;

/**
 * Is the fest taking registrations at all?
 *
 * An event can be open while its fest is not; the stricter of the two wins,
 * which is what makes the fest-wide switch worth having.
 */
export const festAcceptsRegistrations = (fest: Pick<Fest, "status" | "registrationState">): boolean =>
  fest.status === "published" && (fest.registrationState ?? "open") === "open";

/** Should this fest appear in the public explorer? */
export const festIsListed = (fest: Pick<Fest, "status" | "visibility">): boolean =>
  fest.status === "published" && (fest.visibility ?? "public") === "public";
