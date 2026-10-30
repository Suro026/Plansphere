"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/data/api-client";
import type { CreateFest, Fest, UpdateFest } from "@/core/models/fest";
import type { RegistrationFields } from "@/core/models/registration-fields";
import type { CertificateType } from "@/core/models/certificate";

/**
 * The super admin's routes, as hooks.
 *
 * Everything here is a server route rather than a repository call, for one
 * reason: these are the mutations that must be audited, and an audit entry
 * written by the client is not an audit entry. The fest document is still
 * *read* through the repository — reads need no trail and the offline cache
 * is worth keeping.
 */

/* ───────────── dashboard ───────────── */

export interface PlatformStats {
  kpis: {
    fests: number;
    publishedFests: number;
    activeFests: number;
    events: number;
    students: number;
    admins: number;
    volunteers: number;
    registrations: number;
    certificates: number;
  };
  recentFests: Array<{
    id: string;
    name: string;
    slug: string;
    status: string;
    festType: string;
    startDate: string;
    endDate: string;
    stats: { events: number; registrations: number; checkIns: number };
  }>;
  recentAdmins: Array<{
    id: string;
    name: string;
    email: string;
    role: string;
    festIds: string[];
    mustChangePassword: boolean;
    disabled: boolean;
    createdAt: string | null;
  }>;
  recentRegistrations: Array<{
    id: string;
    userName: string;
    userEmail: string;
    eventTitle: string;
    festId: string;
    status: string;
    seats: number;
    createdAt: string | null;
  }>;
}

export const usePlatformStats = () =>
  useQuery({
    queryKey: ["platform-stats"],
    queryFn: () => api<PlatformStats>("/api/admin/platform"),
    staleTime: 30_000,
  });

/* ───────────── fests ───────────── */

export const useCreateFest = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateFest) => api<{ fest: Fest }>("/api/admin/fests", { method: "POST", body: input }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["managed-fests"] });
      client.invalidateQueries({ queryKey: ["platform-stats"] });
    },
  });
};

/** Every verb the fest route accepts, as one discriminated input. */
export type FestAction =
  | { action: "edit"; changes: UpdateFest }
  | { action: "archive" }
  | { action: "reopen"; status?: "draft" | "published" }
  | { action: "transfer"; ownerId: string }
  | { action: "registrationFields"; fields: RegistrationFields };

export const useFestAction = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: FestAction & { id: string }) =>
      api<{ fest: Fest }>(`/api/admin/fests/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["managed-fests"] });
      client.invalidateQueries({ queryKey: ["platform-stats"] });
    },
  });
};

export const useDeleteFest = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ id: string }>(`/api/admin/fests/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["managed-fests"] });
      client.invalidateQueries({ queryKey: ["platform-stats"] });
    },
  });
};

/* ───────────── certificates ───────────── */

export interface ReleaseRecipient {
  userId: string;
  registrationId: string;
  name: string;
  email: string;
  type: CertificateType;
  teamName: string | null;
  position: number | null;
  issued: boolean;
  released: boolean;
  revoked: boolean;
  certificateNumber: string | null;
  deliveryStatus: string | null;
}

export interface ReleasePreview {
  event: { id: string; title: string; festId: string; status: string };
  templateUrl: string | null;
  canPublish: boolean;
  recipients: ReleaseRecipient[];
  unmatched: Array<{ name: string; email: string; type: CertificateType }>;
  byType: Record<string, number>;
}

export const useReleasePreview = (eventId: string | null) =>
  useQuery({
    queryKey: ["certificate-release", eventId],
    enabled: Boolean(eventId),
    queryFn: () => api<ReleasePreview>(`/api/admin/certificates/publish?eventId=${encodeURIComponent(eventId!)}`),
  });

export interface ReleaseSummary {
  eventTitle: string;
  eligible: number;
  created: number;
  published: number;
  existing: number;
  emailed: number;
  skipped: number;
  failed: number;
}

export const usePublishCertificates = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { eventId: string; userIds?: string[]; templateUrl?: string }) =>
      api<ReleaseSummary>("/api/admin/certificates/publish", { method: "POST", body }),
    onSuccess: (_result, variables) => {
      client.invalidateQueries({ queryKey: ["certificate-release", variables.eventId] });
      client.invalidateQueries({ queryKey: ["platform-stats"] });
    },
  });
};

/* ───────────── staff credentials ───────────── */

export interface IssuedCredentials {
  id: string;
  email: string;
  temporaryPassword: string;
  setPasswordLink: string;
  emailed: boolean;
  provider: string;
}

/**
 * Issues a fresh temporary password. The value comes back once and is never
 * stored, so the screen that calls this is the only place it can be read.
 */
export const useResetStaffPassword = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<IssuedCredentials>(`/api/admin/staff/${id}/password`, { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["staff"] }),
  });
};
