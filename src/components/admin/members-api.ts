"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/components/providers";
import { api } from "@/data/api-client";
import type { AssignMember, Duty, FestRole, UpdateMember } from "@/core/models/membership";
import type { UserRole } from "@/core/permissions";

/**
 * The event-role routes, as hooks. Like the staff routes these go through the server: who may assign whom is decided
 * there, and the list needs account details the client cannot read.
 */

export interface MemberRow {
  userId: string;
  name: string;
  email: string;
  role: FestRole;
  eventIds: string[];
  duties: Duty[];
  status: "active" | "suspended" | "revoked";
  createdAt: string | null;
  revokedAt: string | null;
}

/**
 * Present (as "pending") when the change is saved and in force but the person's sign-in claims could not be rewritten just
 * now. The server repairs them the next time they open the app; nothing needs doing.
 */
export type ClaimsSync = "pending";

export const PENDING_CLAIMS_NOTICE = "Saved. Their sign-in couldn't be refreshed just now, so it will update the next time they open the app.";

export interface InviteSent {
  emailed: boolean;
  setPasswordLink?: string;
  /** Returned once, to whoever assigned the role. Never stored. */
  temporaryPassword: string;
}

export interface MyAccess {
  role: UserRole;
  festIds: string[];
  /** The server rewrote this account's claims because its token predated a grant or a revocation: sign in fresh. */
  refreshToken?: boolean;
  claimsError?: boolean;
  memberships: Array<{ festId: string; role: FestRole; eventIds: string[]; duties: Duty[] }>;
}

/**
 * The caller's own event roles, read live. Menus only: every route and rule decides for itself.
 *
 * If the server says the sign-in token predates a grant or a revocation it has just repaired the claims, so this asks
 * Firebase for a fresh token: the rules then see the same roles the API already does, without a sign-out.
 */
export const useMyAccess = (enabled = true) => {
  const { auth } = useAuth();
  return useQuery({
    queryKey: ["my-access"],
    enabled,
    queryFn: async () => {
      const access = await api<MyAccess>("/api/me/access");
      if (access.refreshToken) await auth.getIdToken(true).catch(() => null);
      return access;
    },
    staleTime: 30_000,
  });
};

/**
 * Every fest the caller holds an event role on. Normally this is in the sign-in token; an account with too many to list
 * there (`memberLookup`) gets them from the server instead. `loading` is true while that answer is outstanding.
 */
export const useMemberFests = (): { ids: string[]; loading: boolean } => {
  const { session } = useAuth();
  const lookup = Boolean(session?.memberLookup);
  const access = useMyAccess(lookup);
  const fromToken = session?.memberFestIds;
  const fromServer = access.data?.memberships;
  return React.useMemo(
    () => ({ ids: Array.from(new Set([...(fromToken ?? []), ...(lookup ? (fromServer ?? []).map((m) => m.festId) : [])])), loading: lookup && access.isPending }),
    [fromToken, fromServer, lookup, access.isPending],
  );
};

export const useMembers = (festId: string | undefined) =>
  useQuery({
    queryKey: ["members", festId],
    enabled: Boolean(festId),
    queryFn: () => api<{ members: MemberRow[] }>(`/api/admin/fests/${festId}/members`).then((r) => r.members),
    staleTime: 10_000,
  });

export const useAssignMember = (festId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AssignMember) => api<{ userId: string; role: FestRole; invite?: InviteSent; claimsSync?: ClaimsSync }>(`/api/admin/fests/${festId}/members`, { method: "POST", body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["members", festId] }),
  });
};

export const useUpdateMember = (festId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, patch }: { userId: string; patch: UpdateMember }) =>
      api<{ userId: string; claimsSync?: ClaimsSync }>(`/api/admin/fests/${festId}/members/${userId}`, { method: "PATCH", body: patch }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["members", festId] }),
  });
};

export const useRevokeMember = (festId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api<{ userId: string; claimsSync?: ClaimsSync }>(`/api/admin/fests/${festId}/members/${userId}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["members", festId] }),
  });
};
