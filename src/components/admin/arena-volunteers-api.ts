"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/data/api-client";

/**
 * The arena roster routes, as hooks. Like the staff and event-role routes these go through the server: who may score at a
 * fest depends on event-role memberships a browser cannot read, and the server applies the same rule when it saves.
 */

export interface ArenaVolunteerRow {
  id: string;
  name: string;
  email: string;
  /** An event role with the scoring duty ("event"), or the older fest-wide volunteer scope ("fest"). */
  source: "event" | "fest";
}

export const useArenaVolunteers = (festId: string | undefined) =>
  useQuery({
    queryKey: ["arena-volunteers", festId],
    enabled: Boolean(festId),
    queryFn: () => api<{ volunteers: ArenaVolunteerRow[] }>(`/api/admin/arenas/volunteers?festId=${encodeURIComponent(festId ?? "")}`).then((r) => r.volunteers),
    staleTime: 10_000,
  });

export const useAssignArenaVolunteer = () =>
  useMutation({
    mutationFn: ({ arenaId, userId }: { arenaId: string; userId: string }) =>
      api<{ shift: { id: string }; alreadyAssigned: boolean }>(`/api/admin/arenas/${arenaId}/assign`, { method: "POST", body: { userId } }),
  });
