"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { Registration } from "@/core/models/registration";
import type { Event } from "@/core/models/event";
import type { Fest } from "@/core/models/fest";
import type { Attendance, FoodCollection } from "@/core/models/attendance";
import { useAuth, useRepositories } from "@/components/providers";
import { memberFor } from "@/core/models/registration";
import { ENTRIES_CACHE_KEY as CACHE_KEY } from "@/lib/privacy/local-data";

export interface Entry {
  registration: Registration;
  event: Event | null;
  fest: Fest | null;
  attendance: Attendance | null;
  meals: FoodCollection[];
  /**
   * A team entry that names me but that I have not accepted yet. It shows
   * under Teams as an invitation and nowhere else — not on the pass, not in
   * My events — until I answer.
   */
  invited?: boolean;
}

/** Dates survive JSON as strings; put them back. */
const revive = (raw: string): Entry[] => {
  const parsed = JSON.parse(raw, (key, value) =>
    typeof value === "string" && /At$|Date$|^scannedAt$|^collectedAt$/.test(key) && !Number.isNaN(Date.parse(value))
      ? new Date(value)
      : value,
  );
  return Array.isArray(parsed) ? (parsed as Entry[]) : [];
};

/**
 * Everything the student holds: registrations joined with their events,
 * fests, check-in and meals.
 *
 * The last successful result is written to localStorage and used as the
 * initial data, so "My pass" renders a scannable QR with no network at all.
 * That is the whole point of the ticket living in the app rather than in a
 * screenshot: the gate is exactly where the Wi-Fi fails.
 */
export const useMyEntries = () => {
  const { session } = useAuth();
  const repos = useRepositories();

  const cached = React.useMemo<Entry[] | undefined>(() => {
    if (typeof window === "undefined" || !session) return undefined;
    try {
      const raw = window.localStorage.getItem(`${CACHE_KEY}.${session.uid}`);
      return raw ? revive(raw) : undefined;
    } catch {
      return undefined;
    }
  }, [session]);

  const query = useQuery({
    queryKey: ["my-entries", session?.uid],
    enabled: Boolean(session),
    initialData: cached,
    initialDataUpdatedAt: cached ? 0 : undefined,
    staleTime: 15_000,
    queryFn: async (): Promise<Entry[]> => {
      if (!session) return [];

      const joined = await repos.registrations.listForUserWithEvents(session.uid, session.email);
      if (joined.length === 0) return [];

      const eventIds = [...new Set(joined.map((j) => j.registration.eventId))];
      const events = await repos.events.getManyByIds(eventIds);
      const eventById = new Map(events.map((e) => [e.id, e]));

      const festIds = [...new Set(joined.map((j) => j.registration.festId))];
      const fests = (await Promise.all(festIds.map((id) => repos.fests.getById(id).catch(() => null)))).filter(
        (f): f is Fest => f !== null,
      );
      const festById = new Map(fests.map((f) => [f.id, f]));

      const attendance = await Promise.all(
        joined.map((j) => repos.attendance.getByRegistration(j.registration.id).catch(() => null)),
      );

      // Meals: one owner-scoped query, grouped by entry.
      const allMeals = await repos.attendance.listMealsForUser(session.uid).catch(() => []);
      const mealsByReg = new Map<string, FoodCollection[]>();
      for (const meal of allMeals) {
        const list = mealsByReg.get(meal.registrationId) ?? [];
        list.push(meal);
        mealsByReg.set(meal.registrationId, list);
      }

      return joined.map((j, i) => ({
        registration: j.registration,
        event: eventById.get(j.registration.eventId) ?? null,
        fest: festById.get(j.registration.festId) ?? null,
        attendance: attendance[i] ?? null,
        meals: mealsByReg.get(j.registration.id) ?? [],
        invited:
          j.registration.userId !== session.uid && memberFor(j.registration, session.email)?.inviteStatus === "pending",
      }));
    },
  });

  React.useEffect(() => {
    if (!session || !query.data || query.isPlaceholderData) return;
    try {
      window.localStorage.setItem(`${CACHE_KEY}.${session.uid}`, JSON.stringify(query.data));
    } catch {
      // Storage full or blocked — the page still works, just not offline.
    }
  }, [session, query.data, query.isPlaceholderData]);

  const [online, setOnline] = React.useState(true);
  React.useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  return { ...query, entries: query.data ?? [], online, fromCache: Boolean(cached) && query.isFetching && !query.isFetched };
};

/** Upcoming (today or later), attended, and past-unattended buckets. */
export const bucketEntries = (entries: Entry[], today = new Date().toISOString().slice(0, 10)) => {
  const upcoming: Entry[] = [];
  const attended: Entry[] = [];
  const past: Entry[] = [];

  for (const entry of entries) {
    if (entry.registration.status === "cancelled" || entry.invited) continue;
    if (entry.attendance) attended.push(entry);
    else if (!entry.event || entry.event.date >= today) upcoming.push(entry);
    else past.push(entry);
  }

  const byDate = (a: Entry, b: Entry) => (a.event?.date ?? "").localeCompare(b.event?.date ?? "");
  upcoming.sort(byDate);
  attended.sort((a, b) => -byDate(a, b));
  past.sort((a, b) => -byDate(a, b));

  return { upcoming, attended, past };
};
