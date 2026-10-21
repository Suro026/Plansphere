"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/data/api-client";
import type { AuditAction, AuditEntry } from "@/core/models/audit";

/**
 * The analytics module's server routes, as hooks — everything here needs
 * either `certificateEvents` (server-only, no client rules) or a cross-fest
 * read a staff account's Firestore rules would never allow, so unlike most
 * of the admin app's reads these cannot go straight through a repository.
 */

export interface LinePoint {
  label: string;
  value: number;
}

export interface Distribution {
  top: Array<{ label: string; count: number }>;
  others: number;
  otherGroups: number;
  total: number;
}

export interface FestAnalytics {
  overview: {
    events: number;
    registrations: number;
    students: number;
    volunteers: number;
    certificatesIssued: number;
    attendanceRate: number | null;
    waitlistConversionRate: number | null;
  };
  registrationsOverTime: LinePoint[];
  dailyRegistrations: LinePoint[];
  hourlyPeakRegistration: LinePoint[];
  teamVsIndividual: { team: number; individual: number };
  eventWiseRegistrations: Array<{ eventId: string; eventTitle: string; count: number }>;
  capacityUtilization: Array<{ eventId: string; title: string; capacity: number; registered: number; rate: number }>;
  distributions: { college: Distribution; department: Distribution; academicYear: Distribution; gender: Distribution; city: Distribution };
  attendance: { registered: number; checkedIn: number; noShow: number; attendanceRate: number | null };
  waitlistConversion: { promoted: number; stillWaiting: number; total: number; rate: number | null };
  hourlyEntryTimeline: LinePoint[];
  gateWiseScans: Array<{ gate: string; count: number }>;
  volunteerLeaderboard: Array<{ userId: string; name: string; gateScans: number; foodScans: number; totalScans: number; posts: string[] }>;
  certificates: { eligible: number; released: number; downloaded: number; emailDelivered: number; verificationCount: number };
  certificateDownloadsOverTime: LinePoint[];
  certificateVerificationsOverTime: LinePoint[];
  live: {
    matches: { total: number; live: number; upcoming: number; completed: number; cancelled: number; avgDurationMinutes: number | null };
    arenaUtilization: Array<{ arenaId: string; arenaName: string; matchCount: number; liveCount: number; completedCount: number }>;
    mostActiveVolunteers: Array<{ userId: string; name: string; actionCount: number }>;
    teamWinRate: Array<{ registrationId: string; name: string; wins: number; losses: number; played: number; winRate: number }>;
  };
}

export const useFestAnalytics = (festId: string, options: { eventId?: string; from?: Date; to?: Date } = {}) => {
  const params = new URLSearchParams({ festId });
  if (options.eventId) params.set("eventId", options.eventId);
  if (options.from) params.set("from", options.from.toISOString());
  if (options.to) params.set("to", options.to.toISOString());
  return useQuery({
    queryKey: ["fest-analytics", festId, options.eventId, options.from?.getTime(), options.to?.getTime()],
    queryFn: () => api<FestAnalytics>(`/api/admin/analytics?${params.toString()}`),
    staleTime: 30_000,
  });
};

export interface PlatformAnalytics {
  overview: {
    fests: number;
    events: number;
    registrations: number;
    students: number;
    volunteers: number;
    certificatesIssued: number;
    certificatesReleased: number;
    certificatesDownloaded: number;
    certificateVerifications: number;
    attendanceRate: number | null;
    waitlistConversionRate: number | null;
    activeUsers30d: number;
  };
  registrationsOverTime: LinePoint[];
  dailyRegistrations: LinePoint[];
  hourlyPeakRegistration: LinePoint[];
  teamVsIndividual: { team: number; individual: number };
  festWiseRegistrations: Array<{ festId: string; festName: string; count: number }>;
  distributions: { college: Distribution; department: Distribution; academicYear: Distribution; gender: Distribution; city: Distribution };
  certificateDownloadsOverTime: LinePoint[];
  certificateVerificationsOverTime: LinePoint[];
}

export const usePlatformAnalytics = (options: { from?: Date; to?: Date } = {}) => {
  const params = new URLSearchParams();
  if (options.from) params.set("from", options.from.toISOString());
  if (options.to) params.set("to", options.to.toISOString());
  return useQuery({
    queryKey: ["platform-analytics", options.from?.getTime(), options.to?.getTime()],
    queryFn: () => api<PlatformAnalytics>(`/api/admin/platform/analytics?${params.toString()}`),
    staleTime: 30_000,
  });
};

export interface AuditFilter {
  festId?: string;
  userId?: string;
  action?: AuditAction;
  from?: Date;
  to?: Date;
}

export interface AuditPage {
  entries: AuditEntry[];
  nextCursor: string | null;
}

export const usePlatformAudit = (filter: AuditFilter, cursor: string | null) => {
  const params = new URLSearchParams();
  if (filter.festId) params.set("festId", filter.festId);
  if (filter.userId) params.set("userId", filter.userId);
  if (filter.action) params.set("action", filter.action);
  if (filter.from) params.set("from", filter.from.toISOString());
  if (filter.to) params.set("to", filter.to.toISOString());
  if (cursor) params.set("cursor", cursor);
  return useQuery({
    queryKey: ["platform-audit", filter.festId, filter.userId, filter.action, filter.from?.getTime(), filter.to?.getTime(), cursor],
    // The API speaks JSON, so `createdAt` arrives as an ISO string; the page (and the
    // `AuditEntry` type) work in real `Date`s.
    queryFn: async () => {
      const page = await api<AuditPage>(`/api/admin/platform/audit?${params.toString()}`);
      return { ...page, entries: page.entries.map((entry) => ({ ...entry, createdAt: new Date(entry.createdAt) })) };
    },
    staleTime: 15_000,
  });
};

/** Downloads an Export Center report — same signed-request-then-blob pattern as the registration export. */
export const downloadAnalyticsExport = async (
  params: { scope: "fest" | "platform"; festId?: string; eventId?: string; from?: Date; to?: Date; format: "csv" | "xlsx" | "pdf" },
): Promise<void> => {
  const search = new URLSearchParams({ scope: params.scope, format: params.format });
  if (params.festId) search.set("festId", params.festId);
  if (params.eventId) search.set("eventId", params.eventId);
  if (params.from) search.set("from", params.from.toISOString());
  if (params.to) search.set("to", params.to.toISOString());

  // Dynamically imported: this module is pulled in by every admin analytics
  // screen, and a click-triggered export can afford one extra chunk fetch
  // rather than putting the Firebase client SDK on those screens' first load.
  const [{ firebaseAuth }, { appCheckToken }] = await Promise.all([import("@/data/firebase/client"), import("@/data/firebase/app-check")]);
  const user = firebaseAuth().currentUser;
  const token = await user?.getIdToken();
  const attestation = await appCheckToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (attestation) headers["X-Firebase-AppCheck"] = attestation;

  const res = await fetch(`/api/admin/analytics/export?${search.toString()}`, { headers });
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `analytics.${params.format}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};
