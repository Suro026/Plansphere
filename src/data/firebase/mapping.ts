import {
  FirestoreError,
  Timestamp,
  type DocumentData,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { RepositoryError, type RepositoryErrorCode } from "@/core/models/common";

/**
 * The boundary between Firestore's types and the domain's.
 *
 * Everything Firestore-shaped stops here: `Timestamp` becomes `Date`,
 * `FirestoreError` becomes `RepositoryError`, and `undefined` is stripped
 * before it can reach a write. Screens never see any of it.
 */

/** Firestore `Timestamp` (or anything date-like) to a real `Date`. */
export const toDate = (value: unknown): Date | undefined => {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
};

/** Same, but for fields that must exist. Falls back to the epoch-safe now. */
export const toDateOr = (value: unknown, fallback: Date): Date => toDate(value) ?? fallback;

/**
 * Recursively converts `Timestamp`s in a document to `Date`s.
 *
 * Done generically rather than field-by-field so adding a date to a model does
 * not also mean remembering to convert it in three places.
 */
export const timestampsToDates = <T>(value: T): T => {
  if (value instanceof Timestamp) return value.toDate() as unknown as T;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(timestampsToDates) as unknown as T;

  const out: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = timestampsToDates(item);
  }

  return out as T;
};

/**
 * Firestore rejects `undefined` values outright. Form state produces them
 * constantly (an untouched optional field), so every write is filtered rather
 * than each call site remembering to.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const stripUndefined = <T extends Record<string, unknown>>(value: T): Partial<T> => {
  const out: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;

    // Only plain objects are walked. Anything else — a `serverTimestamp()` or
    // `increment()` sentinel, a `Timestamp`, a `Date` — must reach Firestore as
    // the very same instance: copying a sentinel into a plain object stores it
    // as a map (`{ _methodName: "serverTimestamp" }`) instead of a timestamp.
    if (isPlainObject(item)) {
      out[key] = stripUndefined(item);
      continue;
    }

    out[key] = item;
  }

  return out as Partial<T>;
};

/** Snapshot to a plain object carrying its id, with dates already converted. */
export const snapshotData = (
  snapshot: DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>,
): Record<string, unknown> | null => {
  if (!snapshot.exists()) return null;

  // A pending `serverTimestamp()` reads back as null in a local snapshot until
  // the server acknowledges the write; "estimate" substitutes the client clock
  // so a just-created row does not briefly show a 1970 date.
  return timestampsToDates({ ...snapshot.data({ serverTimestamps: "estimate" }), id: snapshot.id });
};

const FIRESTORE_CODE_MAP: Record<string, RepositoryErrorCode> = {
  "not-found": "not-found",
  "already-exists": "already-exists",
  "permission-denied": "permission-denied",
  unauthenticated: "permission-denied",
  "invalid-argument": "invalid-argument",
  "failed-precondition": "failed-precondition",
  unavailable: "unavailable",
  "deadline-exceeded": "unavailable",
  cancelled: "unavailable",
  aborted: "failed-precondition",
  "resource-exhausted": "unavailable",
};

/**
 * Translates a thrown value into a `RepositoryError`.
 *
 * The messages are deliberately written for the person using the app. A raw
 * `permission-denied` from Firestore tells a student nothing; "You do not have
 * access to this" at least tells them the request was understood and refused.
 */
export const toRepositoryError = (error: unknown, context: string): RepositoryError => {
  if (error instanceof RepositoryError) return error;

  if (error instanceof FirestoreError) {
    const code = FIRESTORE_CODE_MAP[error.code] ?? "unknown";

    const message =
      code === "permission-denied"
        ? "You do not have access to this."
        : code === "unavailable"
          ? "Could not reach the server. Check your connection and try again."
          : code === "not-found"
            ? "That record no longer exists."
            : `${context} failed.`;

    return new RepositoryError(code, message, error);
  }

  // Anything else — a FirebaseError from Auth/Storage, a parse failure, a
  // network stack message — is an internal detail. The person gets the
  // context they were in; the raw error rides along in `cause` for logs.
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[repository] ${context}:`, error);
  }
  return new RepositoryError("unknown", `${context} failed. Please try again.`, error);
};

/** Wraps an async repository call so callers only ever see `RepositoryError`. */
export const guard = async <T>(context: string, operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    throw toRepositoryError(error, context);
  }
};

/**
 * Cryptographically strong random bytes.
 *
 * Ticket and certificate codes must not be guessable, so this uses the Web
 * Crypto API rather than `Math.random`. `crypto.getRandomValues` exists in
 * browsers, in Node 19+, and in React Native via `expo-crypto`, which is why
 * the core models take it as a parameter instead of reaching for it directly.
 */
export const randomBytes = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};
