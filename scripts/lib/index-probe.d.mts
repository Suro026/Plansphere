export interface DeclaredIndexField {
  fieldPath: string;
  order?: "ASCENDING" | "DESCENDING";
  arrayConfig?: "CONTAINS";
}

export interface DeclaredIndex {
  collectionGroup: string;
  queryScope?: string;
  fields: DeclaredIndexField[];
}

export const PROBE_VALUE: string;
export function describeIndex(index: DeclaredIndex): string;
/** Builds the query that runs only when `index` exists. `collection` is `(name) => Query` (Admin or client SDK shape). */
export function buildIndexProbe<Q>(collection: (name: string) => Q, index: DeclaredIndex): Q;
export function missingIndexLink(message: unknown): string | null;
export function isMissingIndexError(error: unknown): boolean;
