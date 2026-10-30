"use client";

import * as React from "react";
import type { Repositories } from "@/core/repositories";
import type { Event } from "@/core/models/event";
import { blockOutcome, type MealType, type ScanMember, type ScanOutcome } from "@/core/models/attendance";
import { RepositoryError } from "@/core/models/common";
import { admissionBlock } from "@/core/models/admission";
import { api, ApiClientError } from "@/data/api-client";
import {
  claimScannerCache,
  clearEventRoster,
  countCheckins,
  dequeue,
  enqueue,
  findAnywhere,
  findInRoster,
  getCheckin,
  getHistoryEntry,
  getMealRecord,
  getMeta,
  listHistory,
  listQueue,
  markCheckedIn,
  purgeStaleRosters,
  pushHistory,
  queueLength,
  replaceCheckins,
  replaceMeals,
  replaceRoster,
  rosterSize,
  searchRoster,
  setMeta,
  setServed,
  unmarkCheckedIn,
  unsetServed,
  updateHistory,
  updateQueued,
  type HistoryEntry,
  type RosterEntry,
} from "./db";

/**
 * Offline-first scanning.
 *
 * The decision — valid, duplicate, unknown, cancelled — is made on the device
 * from the cached roster, in under a millisecond, whether or not there is a
 * network. The write is queued and synced when there is one. The server is
 * still the arbiter: if two devices scanned the same ticket offline, the
 * second one to sync learns it was a duplicate and its history is amended.
 */

const uid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** Accepts a raw ticket code or the public /t/CODE URL the QR encodes. */
export const parseTicketCode = (raw: string): string | null => {
  const text = raw.trim();
  // Anchored after the code so an over-long or mangled code is not silently
  // truncated to a different, possibly valid, ticket.
  const fromUrl = text.match(/\/t\/((?:PS|FF)-[0-9A-HJ-NP-Z]{10})(?![0-9A-Z])/i)?.[1];
  const code = (fromUrl ?? text).toUpperCase();
  return /^(?:PS|FF)-[0-9A-HJ-NP-Z]{10}$/.test(code) ? code : null;
};

/* ───────────── roster ───────────── */

/** What `GET /api/volunteer/roster` answers: the gate's view of one competition, with no contact details in it. */
interface RosterResponse {
  roster: RosterEntry[];
  checkins: Array<{ registrationId: string; at: number; members: string[] }>;
  meals: Array<{ registrationId: string; servedOn: string; mealType: string; served: number; members: string[] }>;
}

/**
 * Pulls the gate's roster for one competition. The server decides what a volunteer may see - names, ticket codes, who is
 * on each entry, whether it is admissible, who is already ticked off - and sends nothing else: no email address, phone
 * number, college or answer ever reaches this device. The competition must be one this volunteer is assigned to.
 */
export const refreshRoster = async (event: Event): Promise<{ roster: number; checkins: number }> => {
  let data: RosterResponse;
  try {
    data = await api<RosterResponse>(`/api/volunteer/roster?eventId=${encodeURIComponent(event.id)}`);
  } catch (error) {
    // The server says this volunteer is no longer on this competition (role revoked or suspended, duty or competition
    // taken away, competition gone). The names must not outlive the permission to see them.
    if (error instanceof ApiClientError && (error.status === 403 || error.status === 404)) await clearEventRoster(event.id).catch(() => undefined);
    throw error;
  }

  await replaceRoster(event.id, data.roster);
  await replaceCheckins(event.id, data.checkins);
  await replaceMeals(event.id, data.meals);
  await setMeta(`roster:${event.id}:refreshedAt`, Date.now());

  return { roster: data.roster.length, checkins: data.checkins.length };
};

/* ───────────── local decisions ───────────── */

/** What a lookup (no write) tells the gate before it commits anything. */
export type PeekResult =
  | { result: "not-found" }
  | { result: "wrong-event"; expectedEventTitle: string }
  | { result: "cancelled" }
  | { result: "waitlisted" }
  | { result: "draft" }
  | { result: "unpaid" }
  | {
      result: "ready";
      registration: { id: string; userName: string; ticketCode: string; teamName?: string; memberCount: number };
      members: ScanMember[];
      /** True when nobody is left to mark for this action. */
      complete: boolean;
    };

/** Looks a code up against the cached roster without writing anything. */
export const peekEntry = async (eventId: string, code: string): Promise<PeekResult> => {
  const entry = await findInRoster(eventId, code);
  if (!entry) {
    const elsewhere = await findAnywhere(code);
    return elsewhere ? { result: "wrong-event", expectedEventTitle: "another event" } : { result: "not-found" };
  }
  const block = admissionBlock(entry);
  if (block) return blockOutcome(block);

  const existing = await getCheckin(eventId, entry.registrationId);
  const done = new Set<string>(existing ? (existing.members.length ? existing.members : entry.members.map((m) => m.key)) : []);

  return {
    result: "ready",
    registration: { id: entry.registrationId, userName: entry.userName, ticketCode: entry.ticketCode, ...(entry.teamName ? { teamName: entry.teamName } : {}), memberCount: entry.memberCount },
    members: entry.members.map((m) => ({ key: m.key, name: m.name, email: m.email, done: done.has(m.key), ...(done.has(m.key) && existing ? { at: new Date(existing.at) } : {}) })),
    complete: entry.members.every((m) => done.has(m.key)),
  };
};

/** Same lookup, for one meal round. */
export const peekMeal = async (eventId: string, code: string, mealType: MealType, servedOn: string): Promise<PeekResult> => {
  const entry = await findInRoster(eventId, code);
  if (!entry) {
    const elsewhere = await findAnywhere(code);
    return elsewhere ? { result: "wrong-event", expectedEventTitle: "another event" } : { result: "not-found" };
  }
  const block = admissionBlock(entry);
  if (block) return blockOutcome(block);

  const record = await getMealRecord(eventId, entry.registrationId, servedOn, mealType);
  const done = new Set<string>(record.members.length ? record.members : entry.members.slice(0, record.served).map((m) => m.key));

  return {
    result: "ready",
    registration: { id: entry.registrationId, userName: entry.userName, ticketCode: entry.ticketCode, ...(entry.teamName ? { teamName: entry.teamName } : {}), memberCount: entry.memberCount },
    members: entry.members.map((m) => ({ key: m.key, name: m.name, email: m.email, done: done.has(m.key) })),
    complete: entry.members.every((m) => done.has(m.key)),
  };
};

export interface DecideInput {
  event: Event;
  code: string;
  gate?: string;
  scannedBy: string;
  online: boolean;
  /**
   * Who this scan is for. Absent means everyone still outstanding on the
   * entry — which is what a solo ticket always is, and what a team that
   * walked in together is.
   */
  memberKeys?: string[];
}

/** The roster as the result screen shows it: who is done, who is not. */
const membersView = (entry: RosterEntry, done: Set<string>, at?: number): ScanMember[] =>
  entry.members.map((member) => ({
    key: member.key,
    name: member.name,
    email: member.email,
    done: done.has(member.key),
    ...(done.has(member.key) && at ? { at: new Date(at) } : {}),
  }));

export const decideEntry = async (input: DecideInput): Promise<ScanOutcome> => {
  const { event, code } = input;
  const entry = await findInRoster(event.id, code);

  if (!entry) {
    const elsewhere = await findAnywhere(code);
    const outcome: ScanOutcome = elsewhere ? { result: "wrong-event", expectedEventTitle: "another event" } : { result: "not-found" };
    await pushHistory({ id: uid(), eventId: event.id, kind: "entry", at: Date.now(), ticketCode: code, userName: elsewhere?.userName ?? "—", outcome: outcome.result, queued: false });
    return outcome;
  }

  const block = admissionBlock(entry);
  if (block) {
    const refused = blockOutcome(block);
    await pushHistory({ id: uid(), eventId: event.id, kind: "entry", at: Date.now(), ticketCode: code, userName: entry.userName, teamName: entry.teamName, outcome: refused.result, queued: false });
    return refused;
  }

  const existing = await getCheckin(event.id, entry.registrationId);

  // A record with no member list is a pre-per-member scan: it marked the
  // whole entry, and is read that way.
  const done = new Set<string>(
    existing ? (existing.members.length ? existing.members : entry.members.map((m) => m.key)) : [],
  );

  const wanted = input.memberKeys?.length ? input.memberKeys : entry.members.map((m) => m.key);
  const marking = wanted.filter((key) => !done.has(key));

  if (marking.length === 0) {
    await pushHistory({
      id: uid(),
      eventId: event.id,
      kind: "entry",
      at: Date.now(),
      ticketCode: code,
      userName: entry.userName,
      teamName: entry.teamName,
      outcome: "already-recorded",
      queued: false,
      registrationId: entry.registrationId,
      ...(input.gate ? { gate: input.gate } : {}),
    });
    return {
      result: "already-recorded",
      at: new Date(existing?.at ?? Date.now()),
      ...(existing?.local ? { by: "this device" } : {}),
      registration: { id: entry.registrationId, userName: entry.userName, ticketCode: code, ...(entry.teamName ? { teamName: entry.teamName } : {}), memberCount: entry.memberCount },
      members: membersView(entry, done, existing?.at),
    };
  }

  const at = Date.now();
  await markCheckedIn(event.id, entry.registrationId, at, true, marking);
  const queueId = uid();
  await enqueue({
    id: queueId,
    kind: "entry",
    eventId: event.id,
    festId: entry.festId,
    registrationId: entry.registrationId,
    ticketCode: code,
    scannedAt: at,
    gate: input.gate,
    memberKeys: marking,
    ownerUid: input.scannedBy,
    attempts: 0,
  });

  const names = entry.members.filter((m) => marking.includes(m.key)).map((m) => m.name);
  await pushHistory({
    id: uid(),
    eventId: event.id,
    kind: "entry",
    at,
    ticketCode: code,
    userName: entry.userName,
    teamName: entry.teamName,
    outcome: "ok",
    queued: !input.online,
    registrationId: entry.registrationId,
    memberKeys: marking,
    memberNames: names,
    queueId,
    ...(input.gate ? { gate: input.gate } : {}),
  });

  for (const key of marking) done.add(key);

  return {
    result: "ok",
    registration: { id: entry.registrationId, userName: entry.userName, ticketCode: code, ...(entry.teamName ? { teamName: entry.teamName } : {}), memberCount: entry.memberCount },
    queued: true,
    marked: marking,
    members: membersView(entry, done, at),
  };
};

export const decideMeal = async (input: DecideInput & { mealType: MealType; servedOn: string; post?: string }): Promise<ScanOutcome> => {
  const { event, code } = input;
  const entry = await findInRoster(event.id, code);

  if (!entry) {
    await pushHistory({ id: uid(), eventId: event.id, kind: "meal", at: Date.now(), ticketCode: code, userName: "—", outcome: "not-found", queued: false, mealType: input.mealType });
    return { result: "not-found" };
  }
  const block = admissionBlock(entry);
  if (block) {
    const refused = blockOutcome(block);
    await pushHistory({ id: uid(), eventId: event.id, kind: "meal", at: Date.now(), ticketCode: code, userName: entry.userName, teamName: entry.teamName, outcome: refused.result, queued: false, mealType: input.mealType });
    return refused;
  }

  const record = await getMealRecord(event.id, entry.registrationId, input.servedOn, input.mealType);

  // An older device state counted servings without naming them; read the
  // first N members as covered so nobody is served twice.
  const done = new Set<string>(
    record.members.length ? record.members : entry.members.slice(0, record.served).map((m) => m.key),
  );

  const wanted = input.memberKeys?.length ? input.memberKeys : entry.members.map((m) => m.key);
  const serving = wanted.filter((key) => !done.has(key));

  if (serving.length === 0) {
    await pushHistory({
      id: uid(),
      eventId: event.id,
      kind: "meal",
      at: Date.now(),
      ticketCode: code,
      userName: entry.userName,
      teamName: entry.teamName,
      outcome: "already-recorded",
      queued: false,
      mealType: input.mealType,
      registrationId: entry.registrationId,
      servedOn: input.servedOn,
      ...(input.post ? { gate: input.post } : {}),
    });
    return {
      result: "already-recorded",
      at: new Date(),
      registration: { id: entry.registrationId, userName: entry.userName, ticketCode: code, ...(entry.teamName ? { teamName: entry.teamName } : {}), memberCount: entry.memberCount },
      members: membersView(entry, done),
    };
  }

  const at = Date.now();
  const total = done.size + serving.length;
  await setServed(event.id, entry.registrationId, input.servedOn, input.mealType, total, serving);
  const queueId = uid();
  await enqueue({
    id: queueId,
    kind: "meal",
    eventId: event.id,
    festId: entry.festId,
    registrationId: entry.registrationId,
    ticketCode: code,
    scannedAt: at,
    gate: input.post,
    mealType: input.mealType,
    servedOn: input.servedOn,
    serving: total,
    memberKeys: serving,
    ownerUid: input.scannedBy,
    attempts: 0,
  });

  const names = entry.members.filter((m) => serving.includes(m.key)).map((m) => m.name);
  await pushHistory({
    id: uid(),
    eventId: event.id,
    kind: "meal",
    at,
    ticketCode: code,
    userName: entry.userName,
    teamName: entry.teamName,
    outcome: "ok",
    queued: !input.online,
    mealType: input.mealType,
    registrationId: entry.registrationId,
    servedOn: input.servedOn,
    memberKeys: serving,
    memberNames: names,
    queueId,
    ...(input.post ? { gate: input.post } : {}),
  });

  for (const key of serving) done.add(key);

  return {
    result: "ok",
    registration: { id: entry.registrationId, userName: entry.userName, ticketCode: code, ...(entry.teamName ? { teamName: entry.teamName } : {}), memberCount: entry.memberCount },
    queued: true,
    serving: { n: total, of: entry.memberCount },
    marked: serving,
    members: membersView(entry, done, at),
  };
};

/* ───────────── manual search ───────────── */

/**
 * The fallback when a camera will not read a code: a dead phone screen, a
 * cracked one, a printout that went through the rain.
 *
 * Runs against the cached roster, so it works with no network — which is the
 * only reason it is worth having, because a gate with signal could just
 * query. Matches a registration id, a ticket code, a team name, a person's
 * name, their phone or their college.
 */
export const manualSearch = async (eventId: string, term: string, limit = 12): Promise<RosterEntry[]> =>
  searchRoster(eventId, term, limit);

/* ───────────── undo ───────────── */

/** How long a volunteer may take a scan back. After this it is a record. */
export const UNDO_WINDOW_MS = 30_000;

export const canUndo = (entry: Pick<HistoryEntry, "at" | "outcome" | "undone">, now = Date.now()): boolean =>
  entry.outcome === "ok" && entry.undone !== true && now - entry.at <= UNDO_WINDOW_MS;

export const undoRemainingMs = (entry: Pick<HistoryEntry, "at">, now = Date.now()): number =>
  Math.max(0, UNDO_WINDOW_MS - (now - entry.at));

/**
 * Takes back the last scan, if it is still within the window.
 *
 * Only a scan that has not synced yet can be undone cleanly: the queued write
 * is dropped and the device's own state is rolled back. One that already
 * reached the server is refused rather than deleted — a volunteer may not
 * remove an attendance record, and the rules would refuse it anyway. Removing
 * a synced check-in is an admin action, which is where it belongs.
 */
export const undoScan = async (
  historyId: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: "expired" | "synced" | "not-found" }> => {
  const entry = await getHistoryEntry(historyId);
  if (!entry || entry.outcome !== "ok") return { ok: false, reason: "not-found" };
  if (entry.undone) return { ok: false, reason: "not-found" };
  if (now - entry.at > UNDO_WINDOW_MS) return { ok: false, reason: "expired" };

  // Still in the queue? Then nothing has left the device.
  const queued = entry.queueId ? (await listQueue()).find((item) => item.id === entry.queueId) : undefined;
  if (!queued) return { ok: false, reason: "synced" };

  await dequeue(queued.id);

  const keys = entry.memberKeys ?? [];
  if (entry.kind === "entry" && entry.registrationId) {
    await unmarkCheckedIn(entry.eventId, entry.registrationId, keys);
  } else if (entry.kind === "meal" && entry.registrationId && entry.servedOn && entry.mealType) {
    await unsetServed(entry.eventId, entry.registrationId, entry.servedOn, entry.mealType, keys);
  }

  await updateHistory({ ...entry, undone: true });
  return { ok: true };
};

/* ───────────── sync ───────────── */

let syncing: Promise<{ synced: number; failed: number }> | null = null;

/**
 * Drains the queue in order. A server "already-recorded" means another device
 * beat us to it — that is a success for the queue (the record exists) and is
 * noted in history. Network failures keep the item with a backoff counter;
 * anything else (a cancelled registration, say) is dropped after five tries
 * so one bad item cannot block the rest forever.
 */
export const syncQueue = (repos: Repositories, scannedBy: string): Promise<{ synced: number; failed: number }> => {
  if (syncing) return syncing;
  syncing = (async () => {
    let synced = 0;
    let failed = 0;
    // Only this account's own scans. Someone else's wait on the device for their owner: uploading them here would put them
    // under the wrong name and judge them against the wrong person's duties. (Scans queued before owners were recorded
    // have none, and are synced by whoever is signed in, as they always were.)
    for (const item of (await listQueue()).filter((queued) => !queued.ownerUid || queued.ownerUid === scannedBy)) {
      try {
        const outcome =
          item.kind === "entry"
            ? await repos.attendance.recordScan({
                ticketCode: item.ticketCode,
                eventId: item.eventId,
                festId: item.festId,
                scannedBy,
                gate: item.gate,
                scannedAt: new Date(item.scannedAt),
                // The subset this scan marked, so a queued second wave adds
                // only its own people rather than the whole team.
                ...(item.memberKeys?.length ? { memberKeys: item.memberKeys } : {}),
              })
            : await repos.attendance.recordMeal({
                ticketCode: item.ticketCode,
                eventId: item.eventId,
                festId: item.festId,
                collectedBy: scannedBy,
                post: item.gate,
                mealType: item.mealType!,
                servedOn: item.servedOn!,
                scannedAt: new Date(item.scannedAt),
                ...(item.memberKeys?.length ? { memberKeys: item.memberKeys } : {}),
              });

        if (outcome.result === "ok" || outcome.result === "already-recorded") {
          await dequeue(item.id);
          synced += 1;
          if (item.kind === "entry") {
            // Whether we won the race or another device did, the record now
            // exists on the server — record it as synced, not local.
            const confirmedAt = outcome.result === "already-recorded" ? outcome.at.getTime() : item.scannedAt;
            await markCheckedIn(item.eventId, item.registrationId, confirmedAt, false, item.memberKeys ?? []);
          }
        } else {
          // Not-found / cancelled / wrong-event from the server: the roster was
          // stale. Drop it; the history already shows what this device saw.
          await dequeue(item.id);
          failed += 1;
        }
      } catch (error) {
        const transient = error instanceof RepositoryError ? error.code === "unavailable" || error.code === "unknown" : true;
        if (transient && item.attempts < 50) {
          await updateQueued({ ...item, attempts: item.attempts + 1, lastError: error instanceof Error ? error.message : String(error) });
        } else if (item.attempts >= 5) {
          await dequeue(item.id);
        } else {
          await updateQueued({ ...item, attempts: item.attempts + 1, lastError: error instanceof Error ? error.message : String(error) });
        }
        failed += 1;
        // Stop on the first network failure — the rest will fail the same way.
        if (transient) break;
      }
    }
    if (synced) await setMeta("lastSyncAt", Date.now());
    return { synced, failed };
  })().finally(() => {
    syncing = null;
  });
  return syncing;
};

/* ───────────── hook ───────────── */

export interface ScannerState {
  online: boolean;
  pending: number;
  syncing: boolean;
  lastSyncAt: Date | null;
  rosterCount: number;
  checkinCount: number;
  rosterRefreshedAt: Date | null;
  history: HistoryEntry[];
}

export const useScannerSync = (repos: Repositories, scannedBy: string | undefined, event: Event | null) => {
  const [state, setState] = React.useState<ScannerState>({
    online: true,
    pending: 0,
    syncing: false,
    lastSyncAt: null,
    rosterCount: 0,
    checkinCount: 0,
    rosterRefreshedAt: null,
    history: [],
  });

  const refreshState = React.useCallback(async () => {
    const [pending, lastSyncAt, rosterCount, checkinCount, refreshedAt, history] = await Promise.all([
      queueLength().catch(() => 0),
      getMeta<number>("lastSyncAt").catch(() => null),
      event ? rosterSize(event.id).catch(() => 0) : 0,
      event ? countCheckins(event.id).catch(() => 0) : 0,
      event ? getMeta<number>(`roster:${event.id}:refreshedAt`).catch(() => null) : null,
      listHistory(event?.id, 30).catch(() => [] as HistoryEntry[]),
    ]);
    setState((s) => ({
      ...s,
      pending,
      lastSyncAt: lastSyncAt ? new Date(lastSyncAt) : null,
      rosterCount,
      checkinCount,
      rosterRefreshedAt: refreshedAt ? new Date(refreshedAt) : null,
      history,
    }));
  }, [event]);

  const sync = React.useCallback(async () => {
    if (!scannedBy || !navigator.onLine) return;
    setState((s) => ({ ...s, syncing: true }));
    try {
      await syncQueue(repos, scannedBy);
    } finally {
      setState((s) => ({ ...s, syncing: false }));
      await refreshState();
    }
  }, [repos, scannedBy, refreshState]);

  const refreshRosterNow = React.useCallback(async () => {
    if (!event || !navigator.onLine) return;
    // The cache first belongs to whoever is signed in now (and is emptied if it was another account's, or an older
    // version's), and anything stale from a past event goes, before a new roster is fetched into it.
    if (scannedBy) {
      await claimScannerCache(scannedBy).catch(() => undefined);
      await purgeStaleRosters().catch(() => 0);
    }
    await refreshRoster(event);
    await refreshState();
  }, [event, scannedBy, refreshState]);

  React.useEffect(() => {
    setState((s) => ({ ...s, online: navigator.onLine }));
    const up = () => {
      setState((s) => ({ ...s, online: true }));
      void sync();
    };
    const down = () => setState((s) => ({ ...s, online: false }));
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, [sync]);

  // Refresh the roster on open and every two minutes while online; retry the
  // queue every 20 seconds while anything is pending.
  React.useEffect(() => {
    void refreshState();
    if (!event) return;
    void refreshRosterNow().then(() => sync());
    const roster = setInterval(() => void refreshRosterNow(), 120_000);
    const drain = setInterval(() => void sync(), 20_000);
    return () => {
      clearInterval(roster);
      clearInterval(drain);
    };
  }, [event, refreshRosterNow, refreshState, sync]);

  return { ...state, sync, refreshRoster: refreshRosterNow, refreshState };
};
