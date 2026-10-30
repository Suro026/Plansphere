import type { Page, PageRequest, Unsubscribe } from "../models/common";
import type { CreateFest, Fest, FestStatus, UpdateFest } from "../models/fest";

export interface FestQuery extends PageRequest {
  status?: FestStatus | FestStatus[];
  /** Restricts to the fests an organizer administers. */
  festIds?: string[];
}

export interface FestRepository {
  getById(id: string): Promise<Fest | null>;

  getBySlug(slug: string): Promise<Fest | null>;

  subscribeById(
    id: string,
    onChange: (fest: Fest | null) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  list(query?: FestQuery): Promise<Page<Fest>>;

  /** Published fests only — what the student-facing explorer shows. */
  listPublished(): Promise<Fest[]>;

  subscribe(
    query: FestQuery,
    onChange: (fests: Fest[]) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  /** Rejects with `already-exists` when the slug is taken. */
  create(input: CreateFest, createdBy: string): Promise<Fest>;

  update(id: string, changes: UpdateFest): Promise<void>;

  setStatus(id: string, status: FestStatus): Promise<void>;

  /** Rejects with `failed-precondition` while the fest still has events. */
  delete(id: string): Promise<void>;

  isSlugAvailable(slug: string): Promise<boolean>;
}
