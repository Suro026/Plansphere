import type { Unsubscribe } from "../models/common";
import type { Arena, CreateArena, UpdateArena } from "../models/arena";

export interface ArenaRepository {
  getById(id: string): Promise<Arena | null>;

  listByFest(festId: string): Promise<Arena[]>;

  subscribeByFest(
    festId: string,
    onChange: (arenas: Arena[]) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe;

  create(input: CreateArena): Promise<Arena>;

  update(id: string, changes: UpdateArena): Promise<void>;

  delete(id: string): Promise<void>;
}
