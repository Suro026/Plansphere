import { doc, getDoc, getDocs, query, where } from "firebase/firestore";
import type { Unsubscribe } from "@/core/models/common";
import { arenaSchema, type Arena, type CreateArena, type UpdateArena } from "@/core/models/arena";
import type { ArenaRepository } from "@/core/repositories/arena-repository";
import { api } from "@/data/api-client";
import { COLLECTIONS } from "../client";
import { guard } from "../mapping";
import { col, parseDoc, parseDocs, sortBy, subscribeList } from "../query-helpers";

const arenas = () => col(COLLECTIONS.arenas);

const byName = (items: Arena[]) => sortBy(items, [(a) => a.name, "asc"]);

/**
 * Arenas are public to read (the live dashboard groups matches by arena) and
 * server-only to write — the same split as fests and events: `/api/admin/arenas`
 * records the audit entry a client write never could.
 */
export class FirestoreArenaRepository implements ArenaRepository {
  getById(id: string): Promise<Arena | null> {
    return guard("Loading arena", async () => {
      const snapshot = await getDoc(doc(arenas(), id));
      return snapshot.exists() ? parseDoc(arenaSchema, snapshot, COLLECTIONS.arenas) : null;
    });
  }

  listByFest(festId: string): Promise<Arena[]> {
    return guard("Loading arenas", async () => {
      const snapshot = await getDocs(query(arenas(), where("festId", "==", festId)));
      return byName(parseDocs(arenaSchema, snapshot.docs, COLLECTIONS.arenas));
    });
  }

  subscribeByFest(festId: string, onChange: (items: Arena[]) => void, onError: (error: unknown) => void): Unsubscribe {
    return subscribeList(query(arenas(), where("festId", "==", festId)), arenaSchema, COLLECTIONS.arenas, (items) => onChange(byName(items)), onError);
  }

  create(input: CreateArena): Promise<Arena> {
    return guard("Creating arena", async () => {
      const response = await api<{ arena: unknown }>("/api/admin/arenas", { method: "POST", body: input });
      const parsed = arenaSchema.safeParse(response.arena);
      if (!parsed.success) throw new Error("Arena was created but could not be read back");
      return parsed.data;
    });
  }

  update(id: string, changes: UpdateArena): Promise<void> {
    return guard("Saving arena", async () => {
      await api<{ arena: unknown }>(`/api/admin/arenas/${id}`, { method: "PATCH", body: changes });
    });
  }

  delete(id: string): Promise<void> {
    return guard("Removing arena", () => api<void>(`/api/admin/arenas/${id}`, { method: "DELETE" }));
  }
}
