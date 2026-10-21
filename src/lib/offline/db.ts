import type { RegistrationStatus } from "@/core/models/registration";
/**
 * The scanner's local database.
 *
 * Venue Wi-Fi collapses at peak entry — exactly when the gate matters — so
 * the scanner keeps everything it needs to decide a scan on the device:
 *
 *  roster    every registration for the event, by ticket code
 *  checkins  registration ids already checked in (server's list, plus ours)
 *  meals     `${registrationId}_${servedOn}_${mealType}` → servings so far
 *  queue     writes waiting for the network, in the order they happened
 *  history   the last scans on this device, for the volunteer's own view
 *
 * Plain IndexedDB behind a tiny promise wrapper. Each fest+event gets its
 * own key space so a volunteer moving between posts never mixes rosters.
 */

const DB_NAME = "plansphere-scanner";
/** The database's name before the FestFlow → Plansphere rename. */
const LEGACY_DB_NAME = "festflow-scanner";
const DB_VERSION = 2;

/**
 * Carries over any writes still queued under the pre-rename database name.
 *
 * A volunteer's queued scan is a check-in that already happened at the
 * gate — the person is already inside — so losing it silently would mean
 * the server never learns they attended, not just a UI inconvenience. Runs
 * once per page load, off the critical path of every other `open()` call.
 */
let legacyMigration: Promise<void> | null = null;

const migrateLegacyQueue = (): Promise<void> => {
  if (legacyMigration) return legacyMigration;
  legacyMigration = (async () => {
    if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return;
    try {
      const existing = await indexedDB.databases();
      if (!existing.some((d) => d.name === LEGACY_DB_NAME)) return;

      const legacyQueue = await new Promise<QueuedScan[]>((resolve, reject) => {
        const req = indexedDB.open(LEGACY_DB_NAME);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("queue")) {
            db.close();
            resolve([]);
            return;
          }
          const getAll = db.transaction("queue", "readonly").objectStore("queue").getAll();
          getAll.onsuccess = () => {
            db.close();
            resolve(getAll.result as QueuedScan[]);
          };
          getAll.onerror = () => {
            db.close();
            reject(getAll.error);
          };
        };
        req.onerror = () => reject(req.error);
      });

      for (const item of legacyQueue) await enqueue(item);
      indexedDB.deleteDatabase(LEGACY_DB_NAME);
    } catch {
      // Best effort — a failed migration must never block the scanner from
      // opening its own database.
    }
  })();
  return legacyMigration;
};

/** One person on an entry, as the device knows them. */
export interface RosterMember {
  key: string;
  name: string;
  email: string;
  phone?: string;
  college?: string;
}

export interface RosterEntry {
  ticketCode: string;
  registrationId: string;
  eventId: string;
  festId: string;
  userId: string;
  userName: string;
  userEmail: string;
  teamName?: string;
  memberCount: number;
  status: RegistrationStatus;
  /** Absent for free and legacy entries. With `status`, this is all the admission rule needs. */
  paymentStatus?: string;
  /** Everyone on the entry — what the gate ticks off one at a time. */
  members: RosterMember[];
  /** Lowercased name/team/phone/id, joined, for manual search with no network. */
  search: string;
}

export interface QueuedScan {
  id: string;
  kind: "entry" | "meal";
  eventId: string;
  festId: string;
  registrationId: string;
  ticketCode: string;
  scannedAt: number;
  gate?: string;
  mealType?: "breakfast" | "lunch" | "dinner" | "snack";
  servedOn?: string;
  serving?: number;
  /** Which members this queued scan marks. */
  memberKeys?: string[];
  attempts: number;
  lastError?: string;
}

export interface HistoryEntry {
  id: string;
  eventId: string;
  kind: "entry" | "meal";
  at: number;
  ticketCode: string;
  userName: string;
  teamName?: string;
  outcome: "ok" | "already-recorded" | "not-found" | "cancelled" | "wrong-event" | "waitlisted" | "draft" | "unpaid";
  queued: boolean;
  mealType?: string;
  /** Where the scan was taken, for the history table. */
  gate?: string;
  /** Who this scan marked, so an undo knows exactly what to take back. */
  memberKeys?: string[];
  memberNames?: string[];
  registrationId?: string;
  servedOn?: string;
  /** Set when the volunteer took it back inside the undo window. */
  undone?: boolean;
  /** The queue item this history row created, if it is still pending. */
  queueId?: string;
}

interface CheckinRecord {
  key: string; // `${eventId}:${registrationId}`
  eventId: string;
  registrationId: string;
  at: number;
  local: boolean;
  /** Member keys marked present. Empty means the whole entry (legacy). */
  members: string[];
}

interface MealRecord {
  key: string; // `${eventId}:${registrationId}:${servedOn}:${mealType}`
  eventId: string;
  registrationId: string;
  servedOn: string;
  mealType: string;
  served: number;
  /** Member keys who have collected this round. */
  members: string[];
  /** Members this device served that the server has not confirmed yet. */
  local: string[];
}

const open = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this context"));
      return;
    }
    void migrateLegacyQueue();
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("roster")) {
        const roster = db.createObjectStore("roster", { keyPath: "key" });
        roster.createIndex("byEvent", "eventId");
      }
      if (!db.objectStoreNames.contains("checkins")) {
        const c = db.createObjectStore("checkins", { keyPath: "key" });
        c.createIndex("byEvent", "eventId");
      }
      if (!db.objectStoreNames.contains("meals")) {
        const m = db.createObjectStore("meals", { keyPath: "key" });
        m.createIndex("byEvent", "eventId");
      }
      if (!db.objectStoreNames.contains("queue")) {
        db.createObjectStore("queue", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("history")) {
        const h = db.createObjectStore("history", { keyPath: "id" });
        h.createIndex("byEvent", "eventId");
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const tx = async <T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> => {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result: T | undefined;
    const req = run(s);
    if (req) req.onsuccess = () => (result = req.result);
    t.oncomplete = () => {
      db.close();
      resolve(result as T);
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
    t.onabort = () => {
      db.close();
      reject(t.error ?? new Error("aborted"));
    };
  });
};

const indexAll = async <T>(store: string, index: string, value: IDBValidKey): Promise<T[]> =>
  tx<T[]>(store, "readonly", (s) => s.index(index).getAll(value));

/* ───────────── roster ───────────── */

export const rosterKey = (eventId: string, ticketCode: string) => `${eventId}:${ticketCode.toUpperCase()}`;

export const replaceRoster = async (eventId: string, entries: RosterEntry[]): Promise<void> => {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("roster", "readwrite");
    const s = t.objectStore("roster");
    const idx = s.index("byEvent");
    const cursorReq = idx.openKeyCursor(eventId);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        s.delete(cursor.primaryKey);
        cursor.continue();
      } else {
        for (const e of entries) s.put({ ...e, key: rosterKey(eventId, e.ticketCode) });
      }
    };
    t.oncomplete = () => {
      db.close();
      resolve();
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
};

export const findInRoster = async (eventId: string, ticketCode: string): Promise<RosterEntry | null> => {
  const row = await tx<(RosterEntry & { key: string }) | undefined>("roster", "readonly", (s) => s.get(rosterKey(eventId, ticketCode)));
  return row ?? null;
};

/** Looks across every cached roster — for "wrong event" detection. */
export const findAnywhere = async (ticketCode: string): Promise<RosterEntry | null> => {
  const all = await tx<(RosterEntry & { key: string })[]>("roster", "readonly", (s) => s.getAll());
  return all.find((r) => r.ticketCode === ticketCode.toUpperCase()) ?? null;
};

export const rosterSize = async (eventId: string): Promise<number> => (await indexAll<RosterEntry>("roster", "byEvent", eventId)).length;

/**
 * Manual lookup over the cached roster — registration id, ticket code, team
 * name, a person's name, phone or college.
 *
 * A linear scan on purpose: a single event's roster is hundreds of rows, not
 * millions, and an IndexedDB index per searchable field would cost more to
 * maintain than the scan costs to run. Every term must match, so "rahul cse"
 * narrows rather than widens.
 */
export const searchRoster = async (eventId: string, term: string, limit = 12): Promise<RosterEntry[]> => {
  const terms = term.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const all = await indexAll<RosterEntry>("roster", "byEvent", eventId);
  return all
    .filter((entry) => {
      const haystack = entry.search ?? `${entry.userName} ${entry.teamName ?? ""} ${entry.ticketCode}`.toLowerCase();
      return terms.every((t) => haystack.includes(t));
    })
    .slice(0, limit);
};

/* ───────────── check-ins ───────────── */

export const markCheckedIn = async (
  eventId: string,
  registrationId: string,
  at: number,
  local: boolean,
  members: string[] = [],
): Promise<void> => {
  // Members accumulate: a team arriving in waves is several scans of one code,
  // and each adds to what the device already knows.
  //
  // `local` is the caller's to decide, not a sticky flag: the scanner sets it
  // when it queues a mark, and the sync clears it once the server has the
  // record. A flag that only ever went true would keep the row out of every
  // future refresh.
  const existing = await getCheckin(eventId, registrationId);
  const merged = [...new Set([...(existing?.members ?? []), ...members])];
  await tx<IDBValidKey>("checkins", "readwrite", (s) =>
    s.put({ key: `${eventId}:${registrationId}`, eventId, registrationId, at: existing?.at ?? at, local, members: merged } satisfies CheckinRecord),
  );
};

/** Takes members back off a check-in — the undo path, and nothing else. */
export const unmarkCheckedIn = async (eventId: string, registrationId: string, members: string[]): Promise<void> => {
  const existing = await getCheckin(eventId, registrationId);
  if (!existing) return;
  const remaining = (existing.members ?? []).filter((key) => !members.includes(key));
  if (remaining.length === 0) {
    await tx<undefined>("checkins", "readwrite", (s) => s.delete(existing.key));
    return;
  }
  await tx<IDBValidKey>("checkins", "readwrite", (s) => s.put({ ...existing, members: remaining } satisfies CheckinRecord));
};

export const getCheckin = async (eventId: string, registrationId: string): Promise<CheckinRecord | null> => {
  const row = await tx<CheckinRecord | undefined>("checkins", "readonly", (s) => s.get(`${eventId}:${registrationId}`));
  return row ? { ...row, members: row.members ?? [] } : null;
};

export const replaceCheckins = async (eventId: string, ids: Array<{ registrationId: string; at: number; members?: string[] }>): Promise<void> => {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("checkins", "readwrite");
    const s = t.objectStore("checkins");
    // Keep local (unsynced) marks; replace the server-sourced ones.
    const req = s.index("byEvent").getAll(eventId);
    req.onsuccess = () => {
      const local = new Map((req.result as CheckinRecord[]).filter((row) => row.local).map((row) => [row.key, row]));
      for (const row of req.result as CheckinRecord[]) if (!row.local) s.delete(row.key);
      for (const { registrationId, at, members } of ids) {
        const key = `${eventId}:${registrationId}`;
        // Anything this device marked but has not synced yet survives the
        // refresh; the server's list is the floor, not the ceiling.
        const merged = [...new Set([...(members ?? []), ...(local.get(key)?.members ?? [])])];
        s.put({ key, eventId, registrationId, at, local: false, members: merged } satisfies CheckinRecord);
      }
    };
    t.oncomplete = () => {
      db.close();
      resolve();
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
};

export const countCheckins = async (eventId: string): Promise<number> => (await indexAll<CheckinRecord>("checkins", "byEvent", eventId)).length;

/* ───────────── meals ───────────── */

const mealKey = (eventId: string, registrationId: string, servedOn: string, mealType: string) => `${eventId}:${registrationId}:${servedOn}:${mealType}`;

export const getMealRecord = async (eventId: string, registrationId: string, servedOn: string, mealType: string): Promise<{ served: number; members: string[] }> => {
  const row = await tx<MealRecord | undefined>("meals", "readonly", (s) => s.get(mealKey(eventId, registrationId, servedOn, mealType)));
  return { served: row?.served ?? 0, members: row?.members ?? [] };
};

export const getServed = async (eventId: string, registrationId: string, servedOn: string, mealType: string): Promise<number> =>
  (await getMealRecord(eventId, registrationId, servedOn, mealType)).served;

export const setServed = async (
  eventId: string,
  registrationId: string,
  servedOn: string,
  mealType: string,
  served: number,
  members: string[] = [],
): Promise<void> => {
  const key = mealKey(eventId, registrationId, servedOn, mealType);
  const row = await tx<MealRecord | undefined>("meals", "readonly", (s) => s.get(key));
  const merged = [...new Set([...(row?.members ?? []), ...members])];
  const local = [...new Set([...(row?.local ?? []), ...members])];
  await tx<IDBValidKey>("meals", "readwrite", (s) =>
    s.put({ key, eventId, registrationId, servedOn, mealType, served: Math.max(served, merged.length), members: merged, local } satisfies MealRecord),
  );
};

/** Undo: hand a round back to the members named. */
export const unsetServed = async (eventId: string, registrationId: string, servedOn: string, mealType: string, members: string[]): Promise<void> => {
  const key = mealKey(eventId, registrationId, servedOn, mealType);
  const existing = await tx<MealRecord | undefined>("meals", "readonly", (s) => s.get(key));
  if (!existing) return;
  const remaining = (existing.members ?? []).filter((m) => !members.includes(m));
  const local = (existing.local ?? []).filter((m) => !members.includes(m));
  await tx<IDBValidKey>("meals", "readwrite", (s) =>
    s.put({ ...existing, members: remaining, local, served: Math.max(0, existing.served - members.length) } satisfies MealRecord),
  );
};

export const replaceMeals = async (eventId: string, rows: Array<{ registrationId: string; servedOn: string; mealType: string; served: number; members?: string[] }>): Promise<void> => {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction("meals", "readwrite");
    const s = t.objectStore("meals");
    const req = s.index("byEvent").getAll(eventId);
    req.onsuccess = () => {
      const existing = new Map((req.result as MealRecord[]).map((m) => [m.key, m]));
      const incoming = new Set(rows.map((r) => mealKey(eventId, r.registrationId, r.servedOn, r.mealType)));

      // Rows the server no longer reports are gone — unless this device
      // served them and has not synced yet, in which case they are ours to
      // keep. Same rule as check-ins; without it a stale local row would
      // refuse a meal forever.
      for (const row of req.result as MealRecord[]) {
        if (incoming.has(row.key)) continue;
        if ((row.local ?? []).length > 0) {
          s.put({ ...row, members: row.local, served: row.local.length } satisfies MealRecord);
        } else {
          s.delete(row.key);
        }
      }

      for (const r of rows) {
        const key = mealKey(eventId, r.registrationId, r.servedOn, r.mealType);
        const held = existing.get(key);
        // Server count wins unless we hold unsynced local servings beyond it.
        const members = [...new Set([...(r.members ?? []), ...(held?.local ?? [])])];
        s.put({
          key,
          eventId,
          registrationId: r.registrationId,
          servedOn: r.servedOn,
          mealType: r.mealType,
          served: Math.max(r.served, members.length),
          members,
          local: held?.local ?? [],
        } satisfies MealRecord);
      }
    };
    t.oncomplete = () => {
      db.close();
      resolve();
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
};

/* ───────────── queue ───────────── */

export const enqueue = (item: QueuedScan) => tx<IDBValidKey>("queue", "readwrite", (s) => s.put(item));
export const dequeue = (id: string) => tx<undefined>("queue", "readwrite", (s) => s.delete(id));
export const updateQueued = (item: QueuedScan) => tx<IDBValidKey>("queue", "readwrite", (s) => s.put(item));
export const listQueue = async (): Promise<QueuedScan[]> => (await tx<QueuedScan[]>("queue", "readonly", (s) => s.getAll())).sort((a, b) => a.scannedAt - b.scannedAt);
export const queueLength = async (): Promise<number> => tx<number>("queue", "readonly", (s) => s.count());

/* ───────────── history ───────────── */

export const pushHistory = async (entry: HistoryEntry): Promise<void> => {
  await tx<IDBValidKey>("history", "readwrite", (s) => s.put(entry));
  // Keep the last 500 per device.
  const all = await tx<HistoryEntry[]>("history", "readonly", (s) => s.getAll());
  if (all.length > 500) {
    const stale = all.sort((a, b) => a.at - b.at).slice(0, all.length - 500);
    const db = await open();
    await new Promise<void>((resolve) => {
      const t = db.transaction("history", "readwrite");
      for (const h of stale) t.objectStore("history").delete(h.id);
      t.oncomplete = () => {
        db.close();
        resolve();
      };
    });
  }
};

export const listHistory = async (eventId?: string, limit = 50): Promise<HistoryEntry[]> => {
  const all = eventId ? await indexAll<HistoryEntry>("history", "byEvent", eventId) : await tx<HistoryEntry[]>("history", "readonly", (s) => s.getAll());
  return all.sort((a, b) => b.at - a.at).slice(0, limit);
};

/**
 * Today's scans, newest first — the only history a volunteer sees.
 *
 * "Today" is the device's local day, because that is the day the volunteer is
 * working; a UTC boundary would empty the list mid-shift at half past five in
 * the morning IST.
 */
export const listToday = async (eventId?: string, now: Date = new Date()): Promise<HistoryEntry[]> => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const all = await listHistory(eventId, 500);
  return all.filter((entry) => entry.at >= start.getTime());
};

export const getHistoryEntry = async (id: string): Promise<HistoryEntry | null> =>
  (await tx<HistoryEntry | undefined>("history", "readonly", (s) => s.get(id))) ?? null;

export const updateHistory = (entry: HistoryEntry) => tx<IDBValidKey>("history", "readwrite", (s) => s.put(entry));

/* ───────────── resetting ───────────── */

/**
 * Forgets everything cached for one event.
 *
 * Used when a volunteer is moved off a post — carrying another event's
 * roster and half-synced marks to a different gate is how the wrong person
 * gets waved through — and by the tests, which need each case to start from
 * nothing.
 */
export const clearEvent = async (eventId: string): Promise<void> => {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(["roster", "checkins", "meals", "history", "queue"], "readwrite");
    for (const store of ["roster", "checkins", "meals", "history"] as const) {
      const s = t.objectStore(store);
      const req = s.index("byEvent").getAllKeys(eventId);
      req.onsuccess = () => {
        for (const key of req.result) s.delete(key);
      };
    }
    const queue = t.objectStore("queue");
    const queued = queue.getAll();
    queued.onsuccess = () => {
      for (const item of queued.result as QueuedScan[]) if (item.eventId === eventId) queue.delete(item.id);
    };
    t.oncomplete = () => {
      db.close();
      resolve();
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
};

/* ───────────── meta ───────────── */

export const getMeta = async <T>(key: string): Promise<T | null> =>
  (await tx<{ key: string; value: T } | undefined>("meta", "readonly", (s) => s.get(key)))?.value ?? null;

export const setMeta = <T>(key: string, value: T) => tx<IDBValidKey>("meta", "readwrite", (s) => s.put({ key, value }));
