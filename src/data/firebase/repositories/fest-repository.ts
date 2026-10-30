import {
  addDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  documentId,
  type QueryConstraint,
} from "firebase/firestore";
import { RepositoryError, type Page, type Unsubscribe } from "@/core/models/common";
import { festIsListed, festSchema, type CreateFest, type Fest, type FestStatus, type UpdateFest } from "@/core/models/fest";
import type { FestQuery, FestRepository } from "@/core/repositories/fest-repository";
import { api } from "@/data/api-client";
import { COLLECTIONS } from "../client";
import { guard, stripUndefined, toRepositoryError } from "../mapping";
import { col, parseDoc, parseDocs, sortBy, subscribeList } from "../query-helpers";

const fests = () => col(COLLECTIONS.fests);

const constraintsFor = (q: FestQuery): QueryConstraint[] => {
  const out: QueryConstraint[] = [];

  if (q.festIds && q.festIds.length > 0) {
    out.push(where(documentId(), "in", q.festIds.slice(0, 30)));
  } else if (q.status) {
    out.push(Array.isArray(q.status) ? where("status", "in", q.status) : where("status", "==", q.status));
  }

  return out;
};

const byStart = (items: Fest[]) => sortBy(items, [(f) => f.startDate, "asc"]);

export class FirestoreFestRepository implements FestRepository {
  getById(id: string): Promise<Fest | null> {
    return guard("Loading fest", async () => {
      const snapshot = await getDoc(doc(fests(), id));
      return snapshot.exists() ? parseDoc(festSchema, snapshot, COLLECTIONS.fests) : null;
    });
  }

  /**
   * Public lookup. The `status == "published"` clause is not a filter for
   * the caller's benefit — it is what lets Firestore prove the read is
   * allowed for an anonymous visitor. Without it the rule
   * `resource.data.status == 'published'` cannot be evaluated against a
   * query and the whole list is refused.
   */
  getBySlug(slug: string): Promise<Fest | null> {
    return guard("Loading fest", async () => {
      const snapshot = await getDocs(
        query(fests(), where("slug", "==", slug.toLowerCase()), where("status", "==", "published")),
      );
      const first = snapshot.docs[0];
      if (!first) return null;
      const fest = parseDoc(festSchema, first, COLLECTIONS.fests);
      // `private` is the owner saying "not yet, and not by link either".
      // `unlisted` still resolves here — that is what unlisted means.
      return fest && fest.visibility !== "private" ? fest : null;
    });
  }

  subscribeById(id: string, onChange: (fest: Fest | null) => void, onError: (error: unknown) => void): Unsubscribe {
    return onSnapshot(
      doc(fests(), id),
      (snapshot) => onChange(snapshot.exists() ? parseDoc(festSchema, snapshot, COLLECTIONS.fests) : null),
      (error) => onError(toRepositoryError(error, "Listening to fest")),
    );
  }

  list(q: FestQuery = {}): Promise<Page<Fest>> {
    return guard("Loading fests", async () => {
      // A staff member's own fests are read one document at a time. A list query cannot be proven to leave out the
      // applications still under review, so the rules only let a super admin list; a document read is checked against
      // that one document. A fest that no longer exists reads as denied (a rule cannot inspect a missing document), so
      // an id that does not resolve is simply left out, as the old `in` query left it out.
      if (q.festIds && q.festIds.length > 0) {
        const ids = Array.from(new Set(q.festIds)).slice(0, 30);
        const found = await Promise.all(
          ids.map((id) =>
            getDoc(doc(fests(), id))
              .then((snapshot) => (snapshot.exists() ? parseDoc(festSchema, snapshot, COLLECTIONS.fests) : null))
              .catch(() => null),
          ),
        );
        return { items: byStart(found.filter((fest): fest is Fest => fest !== null)), cursor: null, hasMore: false };
      }

      const snapshot = await getDocs(query(fests(), ...constraintsFor(q)));
      const items = byStart(parseDocs(festSchema, snapshot.docs, COLLECTIONS.fests));
      return { items, cursor: null, hasMore: false };
    });
  }

  listPublished(): Promise<Fest[]> {
    return guard("Loading fests", async () => {
      const snapshot = await getDocs(query(fests(), where("status", "==", "published")));
      // Visibility is applied here rather than in the query: the field is
      // absent on fests created before it existed, and a `where` clause would
      // silently drop every one of them.
      return byStart(parseDocs(festSchema, snapshot.docs, COLLECTIONS.fests).filter(festIsListed));
    });
  }

  subscribe(q: FestQuery, onChange: (fests: Fest[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(
      query(fests(), ...constraintsFor(q)),
      festSchema,
      COLLECTIONS.fests,
      (items) => onChange(byStart(items)),
      onError,
    );
  }

  create(input: CreateFest, createdBy: string): Promise<Fest> {
    return guard("Creating fest", async () => {
      if (!(await this.isSlugAvailable(input.slug))) {
        throw new RepositoryError("already-exists", `The address "${input.slug}" is already taken.`);
      }

      const ref = await addDoc(
        fests(),
        stripUndefined({
          ...input,
          status: "draft",
          createdBy,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }),
      );

      const created = await getDoc(ref);
      const parsed = parseDoc(festSchema, created, COLLECTIONS.fests);
      if (!parsed) throw new Error("Fest was written but could not be read back");
      return parsed;
    });
  }

  update(id: string, changes: UpdateFest): Promise<void> {
    return guard("Saving fest", async () => {
      await updateDoc(doc(fests(), id), stripUndefined({ ...changes, updatedAt: serverTimestamp() }));
    });
  }

  setStatus(id: string, status: FestStatus): Promise<void> {
    return guard("Updating fest", async () => {
      await updateDoc(doc(fests(), id), { status, updatedAt: serverTimestamp() });
    });
  }

  /** Server-side: refuses while events still exist under the fest. */
  delete(id: string): Promise<void> {
    return guard("Deleting fest", () => api<void>(`/api/admin/fests/${id}`, { method: "DELETE" }));
  }

  isSlugAvailable(slug: string): Promise<boolean> {
    return guard("Checking address", async () => {
      const snapshot = await getCountFromServer(query(fests(), where("slug", "==", slug.toLowerCase())));
      return snapshot.data().count === 0;
    });
  }
}
