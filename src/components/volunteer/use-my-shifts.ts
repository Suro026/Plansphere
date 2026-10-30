"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { Shift } from "@/core/models/shift";
import type { Event } from "@/core/models/event";
import { shiftPhase } from "@/core/models/shift";
import { useAuth, useRepositories } from "@/components/providers";
import { useLive } from "@/components/admin/hooks";
import { listHistory, queueLength, getMeta } from "@/lib/offline/db";
import type { HistoryEntry } from "@/lib/offline/db";

/**
 * A volunteer's own view: their shifts in a fest (live), the events those
 * shifts point at, and what this device has scanned — the numbers on the
 * 5a screens come from here.
 */
export const useMyShifts = (festId: string) => {
  const { session } = useAuth();
  const repos = useRepositories();

  const shifts = useLive<Shift[]>(
    (onChange, onError) => (session ? repos.shifts.subscribeForUser(festId, session.uid, onChange, onError) : () => undefined),
    [festId, session?.uid, repos],
  );

  const eventIds = React.useMemo(() => [...new Set((shifts.data ?? []).flatMap((s) => s.eventIds))], [shifts.data]);
  const events = useQuery({
    queryKey: ["volunteer-events", festId, eventIds.join(",")],
    queryFn: async () => {
      const all = await repos.events.list({ festId, status: ["published", "ongoing", "completed"], limit: 200 });
      return all.items;
    },
    staleTime: 60_000,
  });

  const now = React.useMemo(() => new Date(), [shifts.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = now.toISOString().slice(0, 10);
  const all = React.useMemo(() => (shifts.data ?? []).filter((s) => !s.cancelled), [shifts.data]);
  const active = all.find((s) => shiftPhase(s, now) === "active") ?? null;
  const todays = all.filter((s) => s.date === today);
  const upcoming = all.filter((s) => shiftPhase(s, now) === "upcoming");
  const nextUp = active ?? upcoming[0] ?? null;

  const eventFor = React.useCallback(
    (shift: Shift): Event | null => {
      const list = events.data ?? [];
      if (shift.eventIds.length === 0) return list.find((e) => e.date === shift.date) ?? list[0] ?? null;
      return list.find((e) => shift.eventIds.includes(e.id)) ?? null;
    },
    [events.data],
  );

  return { shifts: all, loading: shifts.loading, events: events.data ?? [], eventFor, active, nextUp, todays, upcoming, now, today };
};

/** What this device has done: scans today, queue, history. */
export const useDeviceActivity = (eventId?: string) => {
  const [state, setState] = React.useState<{ history: HistoryEntry[]; pending: number; lastSyncAt: Date | null; online: boolean }>({
    history: [],
    pending: 0,
    lastSyncAt: null,
    online: true,
  });

  const refresh = React.useCallback(async () => {
    const [history, pending, last] = await Promise.all([
      listHistory(eventId, 100).catch(() => [] as HistoryEntry[]),
      queueLength().catch(() => 0),
      getMeta<number>("lastSyncAt").catch(() => null),
    ]);
    setState((s) => ({ ...s, history, pending, lastSyncAt: last ? new Date(last) : null }));
  }, [eventId]);

  React.useEffect(() => {
    void refresh();
    setState((s) => ({ ...s, online: navigator.onLine }));
    const up = () => setState((s) => ({ ...s, online: true }));
    const down = () => setState((s) => ({ ...s, online: false }));
    const t = setInterval(() => void refresh(), 15_000);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      clearInterval(t);
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, [refresh]);

  const today = new Date().toISOString().slice(0, 10);
  const scansToday = state.history.filter((h) => h.outcome === "ok" && new Date(h.at).toISOString().slice(0, 10) === today).length;

  return { ...state, scansToday, refresh };
};
