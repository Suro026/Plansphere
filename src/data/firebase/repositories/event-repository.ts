import {
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  type QueryConstraint,
} from "firebase/firestore";
import type { Page, Unsubscribe } from "@/core/models/common";
import {
  eventSchema,
  isRegistrationOpen,
  type CreateEvent,
  type Event,
  type EventStatus,
} from "@/core/models/event";
import type { EventQuery, EventRepository } from "@/core/repositories/event-repository";
import { api } from "@/data/api-client";
import { COLLECTIONS } from "../client";
import { guard, toRepositoryError } from "../mapping";
import { col, getManyById, parseDoc, parseDocs, sortBy, subscribeList } from "../query-helpers";

const events = () => col(COLLECTIONS.events);

const parseFromApi = (raw: unknown): Event => {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Server returned an unexpected event shape");
  return parsed.data;
};

/**
 * One server-side filter; the rest in memory. A fest has tens of events, not
 * thousands, so this costs nothing and needs no composite index.
 */
const constraintsFor = (q: EventQuery): QueryConstraint[] => {
  const out: QueryConstraint[] = [];
  if (q.festId) out.push(where("festId", "==", q.festId));
  // Sent to the server as well as applied in memory: for an anonymous reader
  // the rules need the status constraint in the query to allow the list.
  if (q.status) out.push(Array.isArray(q.status) ? where("status", "in", q.status) : where("status", "==", q.status));
  return out;
};

const refine = (items: Event[], q: EventQuery): Event[] => {
  const statuses = q.status ? (Array.isArray(q.status) ? q.status : [q.status]) : null;
  const filtered = items.filter(
    (e) =>
      (!statuses || statuses.includes(e.status)) &&
      (!q.category || e.category === q.category) &&
      (!q.fromDate || e.date >= q.fromDate) &&
      (!q.openOnly || isRegistrationOpen(e)),
  );
  return sortBy(filtered, [(e) => e.date, "asc"], [(e) => e.startTime, "asc"]);
};

export class FirestoreEventRepository implements EventRepository {
  getById(id: string): Promise<Event | null> {
    return guard("Loading event", async () => {
      const snapshot = await getDoc(doc(events(), id));
      return snapshot.exists() ? parseDoc(eventSchema, snapshot, COLLECTIONS.events) : null;
    });
  }

  getBySlug(festId: string, slug: string): Promise<Event | null> {
    return guard("Loading event", async () => {
      // `status in [...]` makes the read provable for anonymous visitors
      // under the rules; staff reach drafts through the admin list instead.
      const snapshot = await getDocs(
        query(
          events(),
          where("festId", "==", festId),
          where("slug", "==", slug.toLowerCase()),
          where("status", "in", ["published", "ongoing", "completed"]),
        ),
      );
      const first = snapshot.docs[0];
      return first ? parseDoc(eventSchema, first, COLLECTIONS.events) : null;
    });
  }

  subscribeById(id: string, onChange: (event: Event | null) => void, onError: (error: unknown) => void): Unsubscribe {
    return onSnapshot(
      doc(events(), id),
      (snapshot) => onChange(snapshot.exists() ? parseDoc(eventSchema, snapshot, COLLECTIONS.events) : null),
      (error) => onError(toRepositoryError(error, "Listening to event")),
    );
  }

  getManyByIds(ids: string[]): Promise<Event[]> {
    return guard("Loading events", () => getManyById(COLLECTIONS.events, ids, eventSchema));
  }

  list(q: EventQuery = {}): Promise<Page<Event>> {
    return guard("Loading events", async () => {
      const snapshot = await getDocs(query(events(), ...constraintsFor(q)));
      const items = refine(parseDocs(eventSchema, snapshot.docs, COLLECTIONS.events), q);
      const limit = q.limit ?? items.length;
      return { items: items.slice(0, limit), cursor: null, hasMore: items.length > limit };
    });
  }

  subscribe(q: EventQuery, onChange: (events: Event[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(
      query(events(), ...constraintsFor(q)),
      eventSchema,
      COLLECTIONS.events,
      (items) => onChange(refine(items, q)),
      onError,
    );
  }

  /**
   * Writes go through the server: the fest's public event counter and an
   * audit entry are written alongside the event, and the capacity / team-size
   * guards run against the live document rather than a client's stale copy.
   */
  create(input: CreateEvent): Promise<Event> {
    return guard("Creating event", async () => {
      const response = await api<{ event: unknown }>("/api/admin/events", { method: "POST", body: input });
      return parseFromApi(response.event);
    });
  }

  update(id: string, changes: Partial<CreateEvent>): Promise<void> {
    return guard("Saving event", async () => {
      const { festId: _festId, ...rest } = changes as Partial<CreateEvent> & { festId?: string };
      void _festId;
      await api<{ event: unknown }>(`/api/admin/events/${id}`, { method: "PATCH", body: rest });
    });
  }

  delete(id: string): Promise<void> {
    return guard("Deleting event", () => api<void>(`/api/admin/events/${id}`, { method: "DELETE" }));
  }

  duplicate(id: string): Promise<Event> {
    return guard("Duplicating event", async () => {
      const response = await api<{ event: unknown }>(`/api/admin/events/${id}/duplicate`, { method: "POST" });
      return parseFromApi(response.event);
    });
  }

  setStatus(id: string, status: EventStatus): Promise<void> {
    return this.update(id, { status });
  }

  setRegistrationOpen(id: string, open: boolean): Promise<void> {
    return this.update(id, { registrationOpen: open });
  }

  countByFest(festId: string): Promise<number> {
    return guard("Counting events", async () => {
      const snapshot = await getCountFromServer(query(events(), where("festId", "==", festId)));
      return snapshot.data().count;
    });
  }

  isSlugAvailable(festId: string, slug: string, excludingEventId?: string): Promise<boolean> {
    return guard("Checking address", async () => {
      const snapshot = await getDocs(
        query(events(), where("festId", "==", festId), where("slug", "==", slug.toLowerCase())),
      );
      return parseDocs(eventSchema, snapshot.docs, COLLECTIONS.events).every((event) => event.id === excludingEventId);
    });
  }
}
