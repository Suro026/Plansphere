import { FieldValue, Timestamp, type DocumentSnapshot } from "firebase-admin/firestore";

/**
 * Admin-SDK documents to JSON the client can parse.
 *
 * Timestamps become ISO strings; the client's Zod schemas use `z.coerce.date()`
 * so they come back as Dates on the other side without a bespoke decoder.
 */
export const toJson = <T = Record<string, unknown>>(value: unknown): T => {
  if (value instanceof Timestamp) return value.toDate().toISOString() as unknown as T;
  if (value instanceof Date) return value.toISOString() as unknown as T;
  if (value === null || typeof value !== "object") return value as T;
  if (Array.isArray(value)) return value.map(toJson) as unknown as T;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = toJson(item);
  return out as T;
};

export const docToJson = <T = Record<string, unknown>>(snapshot: DocumentSnapshot): T | null =>
  snapshot.exists ? toJson<T>({ ...snapshot.data(), id: snapshot.id }) : null;

/**
 * Admin-SDK documents to native `Date`s, for validating against a domain
 * schema server-side — as opposed to `toJson`, which stringifies dates for
 * the wire. Several model schemas (`Attendance.scannedAt`,
 * `Certificate.issuedAt`, and others) intentionally use a bare `z.date()`
 * rather than `z.coerce.date()`, because the client repositories that
 * normally populate them convert `Timestamp` to `Date` by hand before
 * validating. Reusing `toJson` for that same validation server-side would
 * hand those fields a string and fail the whole document.
 */
export const toDates = <T = Record<string, unknown>>(value: unknown): T => {
  if (value instanceof Timestamp) return value.toDate() as unknown as T;
  if (value instanceof Date) return value as unknown as T;
  if (value === null || typeof value !== "object") return value as T;
  if (Array.isArray(value)) return value.map(toDates) as unknown as T;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = toDates(item);
  return out as T;
};

/**
 * Drops `undefined` so Firestore accepts the write.
 *
 * `FieldValue.serverTimestamp()`, `.delete()` and `.increment()` are opaque
 * sentinel objects with no enumerable properties of their own (`increment`
 * carries one, `operand`, but not the operation it names) — recursing into
 * one the way a plain nested object is recursed into does not compact it, it
 * destroys it, replacing "set this to the server's clock" with an empty
 * object literal that Firestore stores exactly as given. They are passed
 * through untouched, the same way `Date` and `Timestamp` already are.
 */
export const compact = <T extends Record<string, unknown>>(value: T): T => {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    out[key] =
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      !(item instanceof Date) &&
      !(item instanceof Timestamp) &&
      !(item instanceof FieldValue)
        ? compact(item as Record<string, unknown>)
        : item;
  }
  return out as T;
};

/** Node's WebCrypto, for ticket and certificate codes. */
export const randomBytes = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};
