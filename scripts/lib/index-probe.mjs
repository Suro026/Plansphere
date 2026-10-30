/**
 * Probing the composite indexes declared in `firestore.indexes.json`.
 *
 * A composite index is "live" when the query that needs it runs; Firestore answers `FAILED_PRECONDITION` with a console link
 * when it does not. `npm run verify:infra` and `/api/health` both ask that question - of EVERY declared index, built from the
 * file itself, so adding an index to the file adds it to both checks and the two cannot drift apart again (the health check
 * used to probe five of nine by hand).
 *
 * Shape of a declared index: equality fields first (each probed with `== "_probe_"`, or `array-contains` for an array field),
 * then the ordered field the query sorts or ranges on, last.
 */

export const PROBE_VALUE = "_probe_";

/** `registrations(eventId ASCENDING, createdAt DESCENDING)` */
export const describeIndex = (index) =>
  `${index.collectionGroup}(${index.fields.map((f) => `${f.fieldPath} ${f.order ?? f.arrayConfig}`).join(", ")})`;

/** The query that can only run when `index` exists. `collection` is `(name) => Query`. */
export const buildIndexProbe = (collection, index) => {
  let query = collection(index.collectionGroup);
  const lastOrdered = [...index.fields].map((f) => Boolean(f.order)).lastIndexOf(true);
  index.fields.forEach((field, position) => {
    if (field.arrayConfig === "CONTAINS") query = query.where(field.fieldPath, "array-contains", PROBE_VALUE);
    else if (position === lastOrdered) query = query.orderBy(field.fieldPath, field.order === "DESCENDING" ? "desc" : "asc");
    else query = query.where(field.fieldPath, "==", PROBE_VALUE);
  });
  return query.limit(1);
};

/** The one-click console link Firestore puts in a missing-index error, if there is one. */
export const missingIndexLink = (message) => String(message ?? "").match(/https:\/\/console\.firebase\.google\.com\S+/)?.[0] ?? null;

/** Whether an error from a probe means "this index does not exist (yet)" rather than something else. */
export const isMissingIndexError = (error) => {
  const message = String(error?.message ?? error ?? "");
  return error?.code === 9 || /FAILED_PRECONDITION/.test(message) || /requires an index|index.*(not|being) (ready|built)|currently building/i.test(message);
};
