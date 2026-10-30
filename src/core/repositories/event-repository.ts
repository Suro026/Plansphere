import type { Page, PageRequest, Unsubscribe } from "../models/common";
import type { CreateEvent, Event, EventCategory, EventStatus } from "../models/event";

export interface EventQuery extends PageRequest {
  festId?: string;
  status?: EventStatus | EventStatus[];
  category?: EventCategory;
  /** Only events whose registration is currently open. */
  openOnly?: boolean;
  /** `YYYY-MM-DD` lower bound, for "upcoming events". */
  fromDate?: string;
}

export interface EventRepository {
  getById(id: string): Promise<Event | null>;

  /** Resolves `/f/{fest}/e/{slug}`. Slugs are unique within a fest only. */
  getBySlug(festId: string, slug: string): Promise<Event | null>;

  /** Live view of one event — seat counts move while a student is deciding. */
  subscribeById(
    id: string,
    onChange: (event: Event | null) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  getManyByIds(ids: string[]): Promise<Event[]>;

  list(query?: EventQuery): Promise<Page<Event>>;

  /**
   * Live event list. The student explorer and the admin dashboard both use
   * this, so a newly published event appears without a refresh — and so the
   * same call works unchanged in the React Native app.
   */
  subscribe(
    query: EventQuery,
    onChange: (events: Event[]) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  create(input: CreateEvent): Promise<Event>;

  update(id: string, changes: Partial<CreateEvent>): Promise<void>;

  /**
   * Deletes an event only when nothing depends on it.
   *
   * Rejects with a `failed-precondition` error when registrations exist —
   * deleting an event out from under a hundred issued tickets would orphan
   * every one of them. Cancel the event instead.
   */
  delete(id: string): Promise<void>;

  /** Copies an event's shape into a fresh draft — no registrations, a new slug. */
  duplicate(id: string): Promise<Event>;

  setStatus(id: string, status: EventStatus): Promise<void>;

  setRegistrationOpen(id: string, open: boolean): Promise<void>;

  countByFest(festId: string): Promise<number>;

  isSlugAvailable(festId: string, slug: string, excludingEventId?: string): Promise<boolean>;
}
