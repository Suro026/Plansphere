import { z } from "zod";

/**
 * Primitives shared by every model.
 *
 * Nothing in `src/core` may import from `next`, `react`, `firebase` or any
 * other platform package. This directory is compiled as-is by the Expo app in
 * Phase 2, so it has to stay free of anything web-specific.
 */

/** A Firestore document id. */
export const idSchema = z.string().min(1).max(128);

/**
 * Dates cross the repository boundary as real `Date` objects. Firestore
 * `Timestamp`s are converted in the data layer so that no consumer of a model
 * ever has to know Firestore exists.
 */
export const dateSchema = z.coerce.date();

/** Every stored document carries these. */
export const auditFieldsSchema = z.object({
  createdAt: dateSchema,
  updatedAt: dateSchema,
});

export type AuditFields = z.infer<typeof auditFieldsSchema>;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email("Enter a valid email address");

/**
 * Deliberately permissive: the platform is used by Indian colleges, where
 * numbers are entered with and without the +91 prefix, and by the occasional
 * international participant.
 */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^[+]?[\d\s()-]{7,20}$/, "Enter a valid phone number");

/** Free text that ends up rendered in the UI or in a PDF. */
export const shortTextSchema = z.string().trim().min(1).max(200);

/**
 * An image or link URL a person supplied. https only: `javascript:` and
 * `data:` pass a plain `.url()` check, and neither belongs in an <img src>
 * or an <a href> we render.
 */
export const httpsUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((value) => value.toLowerCase().startsWith("https://"), "Enter an https:// URL");
/**
 * An optional https URL typed into a form. An untouched text input submits
 * `""`, which is "not provided", not "an invalid URL" — so blank (or
 * whitespace-only) becomes `undefined` before the URL check runs.
 */
export const optionalHttpsUrlSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  httpsUrlSchema.optional(),
);
export const longTextSchema = z.string().trim().max(5000);

/** `YYYY-MM-DD`, stored as a string so a date has no timezone attached. */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");

/** 24-hour `HH:MM`. */
export const clockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a 24-hour HH:MM time");

/**
 * Cursor-based pagination. Firestore pages by document snapshot rather than by
 * offset; the cursor is opaque to callers so a future SQL implementation can
 * put whatever it needs in there.
 */
export interface Page<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

export interface PageRequest {
  limit?: number;
  cursor?: string | null;
}

/** Unsubscribe handle returned by every real-time subscription. */
export type Unsubscribe = () => void;

/**
 * Repositories reject with these rather than leaking a `FirebaseError`, so the
 * UI can branch on a cause without importing a vendor SDK.
 */
export type RepositoryErrorCode =
  | "not-found"
  | "already-exists"
  | "permission-denied"
  | "invalid-argument"
  | "failed-precondition"
  | "unavailable"
  | "unknown";

export class RepositoryError extends Error {
  readonly code: RepositoryErrorCode;
  readonly cause?: unknown;

  constructor(code: RepositoryErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "RepositoryError";
    this.code = code;
    this.cause = cause;
  }
}
