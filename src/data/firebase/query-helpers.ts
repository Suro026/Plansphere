import {
  collection,
  documentId,
  getDocs,
  limit as limitTo,
  onSnapshot,
  query,
  startAfter,
  where,
  type CollectionReference,
  type DocumentData,
  type DocumentSnapshot,
  type Query,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import type { ZodType } from "zod";
import type { Page, PageRequest, Unsubscribe } from "@/core/models/common";
import { normalizeUserDoc } from "@/core/models/user";
import { COLLECTIONS, firestore, type CollectionName } from "./client";
import { snapshotData, toRepositoryError } from "./mapping";

/**
 * Shared plumbing for the Firestore repositories.
 *
 * Every read goes through `parseDoc`, which validates the raw document against
 * the model's Zod schema. A document that fails validation is logged and
 * skipped rather than crashing the list — one malformed record written by an
 * old client must not blank the entire dashboard.
 */

export const col = (name: CollectionName): CollectionReference<DocumentData> => collection(firestore(), name);

export const parseDoc = <T>(
  schema: ZodType<T>,
  snapshot: DocumentSnapshot<DocumentData>,
  label: string,
): T | null => {
  const raw = snapshotData(snapshot);
  if (!raw) return null;

  // Accounts written before the unified user schema keep their name under
  // `fullName` and their student fields in a nested block. Normalise on read
  // so a document the migration has not reached still parses.
  const result = schema.safeParse(label === COLLECTIONS.users ? normalizeUserDoc(raw as Record<string, unknown>) : raw);

  if (!result.success) {
    console.warn(`[firestore] ${label}/${snapshot.id} failed validation`, result.error.issues);
    return null;
  }

  return result.data;
};

export const parseDocs = <T>(
  schema: ZodType<T>,
  docs: QueryDocumentSnapshot<DocumentData>[],
  label: string,
): T[] => docs.map((doc) => parseDoc(schema, doc, label)).filter((item): item is T => item !== null);

/** Default page size. Firestore bills per document, so lists are modest. */
export const DEFAULT_PAGE = 25;
export const MAX_PAGE = 200;

/**
 * Opaque pagination cursor: the last document's id. `startAfter` by id works
 * because every list here orders by a field and then by document id, which
 * Firestore adds implicitly as the tiebreaker.
 */
const cursorCache = new Map<string, QueryDocumentSnapshot<DocumentData>>();

export const runPage = async <T>(
  base: Query<DocumentData>,
  schema: ZodType<T>,
  label: string,
  request: PageRequest = {},
): Promise<Page<T>> => {
  const size = Math.min(MAX_PAGE, Math.max(1, request.limit ?? DEFAULT_PAGE));
  const constraints: QueryConstraint[] = [];

  if (request.cursor) {
    const anchor = cursorCache.get(request.cursor);
    if (anchor) constraints.push(startAfter(anchor));
  }

  // Fetch one extra to learn whether another page exists without a count.
  constraints.push(limitTo(size + 1));

  const snapshot = await getDocs(query(base, ...constraints));
  const docs = snapshot.docs.slice(0, size);
  const hasMore = snapshot.docs.length > size;
  const last = docs[docs.length - 1];

  let cursor: string | null = null;

  if (hasMore && last) {
    cursor = `${label}:${last.id}`;
    cursorCache.set(cursor, last);
  }

  return { items: parseDocs(schema, docs, label), cursor, hasMore };
};

/** Live query with the same parsing, and errors translated for the UI. */
export const subscribeList = <T>(
  q: Query<DocumentData>,
  schema: ZodType<T>,
  label: string,
  onChange: (items: T[]) => void,
  onError: (error: unknown) => void,
): Unsubscribe =>
  onSnapshot(
    q,
    (snapshot) => onChange(parseDocs(schema, snapshot.docs, label)),
    (error) => onError(toRepositoryError(error, `Listening to ${label}`)),
  );

/**
 * `in` queries take at most 30 values. This chunks and merges so callers can
 * pass any number of ids and get one result.
 */
export const getManyById = async <T>(
  name: CollectionName,
  ids: string[],
  schema: ZodType<T>,
): Promise<T[]> => {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 30) chunks.push(unique.slice(i, i + 30));

  const results = await Promise.all(
    chunks.map((chunk) => getDocs(query(col(name), where(documentId(), "in", chunk)))),
  );

  return results.flatMap((snapshot) => parseDocs(schema, snapshot.docs, name));
};

/** Same, for a field other than the id (e.g. all registrations for many events). */
export const getManyByField = async <T>(
  name: CollectionName,
  field: string,
  values: string[],
  schema: ZodType<T>,
  extra: QueryConstraint[] = [],
): Promise<T[]> => {
  const unique = [...new Set(values.filter(Boolean))];
  if (unique.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 30) chunks.push(unique.slice(i, i + 30));

  const results = await Promise.all(
    chunks.map((chunk) => getDocs(query(col(name), where(field, "in", chunk), ...extra))),
  );

  return results.flatMap((snapshot) => parseDocs(schema, snapshot.docs, name));
};

/**
 * In-memory ordering.
 *
 * Firestore needs a composite index for `where(a == x) + orderBy(b)`, and an
 * index that does not exist fails the whole query. Every bounded list here
 * (a fest's events, a student's entries, a shift roster) is small enough to
 * fetch by one equality filter and order in memory, which means the app works
 * on a fresh project before any index has been created. Only the paginated
 * admin tables keep server-side ordering.
 */
export const sortBy = <T>(
  items: T[],
  ...keys: Array<[(item: T) => string | number | Date | undefined | null, "asc" | "desc"]>
): T[] =>
  [...items].sort((a, b) => {
    for (const [pick, dir] of keys) {
      const av = pick(a);
      const bv = pick(b);
      const an = av instanceof Date ? av.getTime() : av ?? "";
      const bn = bv instanceof Date ? bv.getTime() : bv ?? "";
      if (an === bn) continue;
      const cmp = an < bn ? -1 : 1;
      return dir === "asc" ? cmp : -cmp;
    }
    return 0;
  });

/** Case-insensitive contains, applied client-side to a fetched page. */
export const matchesSearch = (haystack: Array<string | undefined | null>, needle: string | undefined): boolean => {
  if (!needle?.trim()) return true;
  const term = needle.trim().toLowerCase();
  return haystack.some((value) => value?.toLowerCase().includes(term));
};
