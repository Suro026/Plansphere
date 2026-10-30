"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Event } from "@/core/models/event";
import type { Registration } from "@/core/models/registration";
import type { Attendance, FoodCollection } from "@/core/models/attendance";
import type { AuditEntry } from "@/core/models/audit";
import type { Shift } from "@/core/models/shift";
import type { Unsubscribe } from "@/core/models/common";
import { useRepositories } from "@/components/providers";

/**
 * Admin data hooks — thin, live, and all through the repositories.
 *
 * `useLive` turns any repository subscription into React state with a
 * loading flag and an error. Every admin screen that shows a moving number
 * (the gate feed, seat counts, the volunteer roster) uses it, so the design's
 * "all figures reconciled 12 seconds ago" is literally true.
 */

export const useLive = <T>(
  subscribe: (onChange: (value: T) => void, onError: (error: unknown) => void) => Unsubscribe,
  deps: React.DependencyList,
) => {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [updatedAt, setUpdatedAt] = React.useState<Date | null>(null);

  React.useEffect(() => {
    setError(null);
    const stop = subscribe(
      (value) => {
        setData(value);
        setUpdatedAt(new Date());
      },
      (err) => setError(err),
    );
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-controlled deps
  }, deps);

  return { data, error, updatedAt, loading: data === null && error === null };
};

export const useFestEvents = (festId: string) => {
  const repos = useRepositories();
  return useLive<Event[]>(
    (onChange, onError) => repos.events.subscribe({ festId }, onChange, onError),
    [festId, repos],
  );
};

export const useFestRegistrations = (festId: string, eventId?: string) => {
  const repos = useRepositories();
  return useLive<Registration[]>(
    (onChange, onError) => repos.registrations.subscribe(eventId ? { eventId, festId } : { festId }, onChange, onError),
    [festId, eventId, repos],
  );
};

export const useEventAttendance = (eventId: string | undefined) => {
  const repos = useRepositories();
  return useLive<Attendance[]>(
    (onChange, onError) => (eventId ? repos.attendance.subscribeByEvent(eventId, onChange, onError) : () => undefined),
    [eventId, repos],
  );
};

export const useFestGateFeed = (festId: string, limit = 50) => {
  const repos = useRepositories();
  return useLive<Attendance[]>(
    (onChange, onError) => repos.attendance.subscribeByFest(festId, onChange, onError, limit),
    [festId, limit, repos],
  );
};

/**
 * A one-time fetch, not `useLive`: unlike the gate feed, seat counts and
 * roster this file's other hooks push live (the whole point of `useLive`,
 * per the note above), an audit trail is read retrospectively — nobody
 * needs the entry for an override to appear on their screen the instant it
 * happens. Reusing `listForFest` here instead of holding a Firestore
 * listener open on every page that shows recent activity is a real
 * reduction in standing connections for a screen nothing depends on being
 * live.
 */
export const useFestAudit = (festId: string, limit = 30) => {
  const repos = useRepositories();
  const query = useQuery<AuditEntry[]>({
    queryKey: ["fest-audit", festId, limit],
    queryFn: () => repos.audit.listForFest(festId, limit),
    staleTime: 30_000,
  });
  return { data: query.data ?? null, error: query.error, updatedAt: query.dataUpdatedAt ? new Date(query.dataUpdatedAt) : null, loading: query.isPending };
};

export const useFestShifts = (festId: string) => {
  const repos = useRepositories();
  return useLive<Shift[]>(
    (onChange, onError) => repos.shifts.subscribeByFest(festId, onChange, onError),
    [festId, repos],
  );
};

/** Meals served across a fest — a query, not a subscription; it is a KPI. */
export const useFestMealCount = (festId: string) => {
  const repos = useRepositories();
  return useQuery({
    queryKey: ["fest-meals", festId],
    queryFn: () => repos.attendance.countMealsByFest(festId),
    staleTime: 30_000,
  });
};

export const useFestCertificateCount = (festId: string) => {
  const repos = useRepositories();
  return useQuery({
    queryKey: ["fest-certificates-count", festId],
    queryFn: () => repos.certificates.countByFest(festId),
    staleTime: 30_000,
  });
};

export const useEventMeals = (eventId: string | undefined) => {
  const repos = useRepositories();
  return useQuery({
    queryKey: ["event-meals", eventId],
    enabled: Boolean(eventId),
    queryFn: () => repos.attendance.listMealsByEvent(eventId!),
    staleTime: 15_000,
  });
};

export const useInvalidate = () => {
  const client = useQueryClient();
  return React.useCallback((...keys: string[]) => keys.forEach((k) => client.invalidateQueries({ queryKey: [k] })), [client]);
};

/** `attended` set for a list of registrations, from the event's attendance. */
export const attendedSet = (attendance: Attendance[] | null): Set<string> =>
  new Set((attendance ?? []).map((a) => a.registrationId));

export type { FoodCollection };
