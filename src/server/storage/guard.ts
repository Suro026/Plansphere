import { ApiError } from "../errors";
import { classifyStorageError } from "./diagnose";

/**
 * What a caller is told when file storage fails, and what the operator reads in the log.
 *
 * Before this, only a missing bucket was turned into a deliberate answer; every other storage failure (a rejected key, a
 * paused or unreachable project, a timeout, a Supabase 5xx) and an unconfigured deployment surfaced as an unrecognised
 * error, which the API handler reports as a generic 500. A storage outage is a 503 - the request was fine, the dependency
 * is not - and it must say so without naming the project, the key or the bucket path.
 *
 * The log line carries one fixed code (the same vocabulary `/api/health` uses) and the bucket name. Never the message the
 * Supabase client returned, which can include a URL or an object path.
 */

export const STORAGE_DISABLED_MESSAGE =
  "File uploads aren’t enabled on this deployment yet. Paste an https:// image URL instead, or ask the platform admin to set up file storage.";
export const STORAGE_UNAVAILABLE_MESSAGE = "File storage is temporarily unavailable. Nothing was saved — try again in a few minutes.";

const statusOf = (error: unknown): number => {
  const e = (error ?? {}) as { status?: unknown; statusCode?: unknown };
  return Number(e.status) || Number(e.statusCode) || 0;
};

/** The deliberate answer for whatever a storage call threw. An error that already is one (an `ApiError`) passes through. */
export const toStorageApiError = (operation: string, error: unknown, bucket?: string): ApiError => {
  if (error instanceof ApiError) return error;

  // Matched by name so this module does not import the client (which holds the key and refuses to load in a browser).
  const notConfigured = error instanceof Error && error.name === "StorageNotConfiguredError";
  const cause = notConfigured ? "not-configured" : classifyStorageError(error);
  console.error(`[storage] ${operation} failed: ${cause}${bucket ? ` (${bucket})` : ""}`);

  const status = statusOf(error);
  if (status === 413) return new ApiError(413, "too-large", "That file is larger than this deployment’s storage accepts.");
  if (status === 415) return new ApiError(415, "unsupported-type", "File storage does not accept that kind of file.");

  if (cause === "not-configured" || cause === "bucket-missing") return new ApiError(503, "storage-disabled", STORAGE_DISABLED_MESSAGE);
  return new ApiError(503, "storage-unavailable", STORAGE_UNAVAILABLE_MESSAGE);
};

/** Runs one storage call and turns any failure into `toStorageApiError`. */
export const guardStorage = async <T>(operation: string, bucket: string | undefined, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw toStorageApiError(operation, error, bucket);
  }
};
