import { z } from "zod";
import { buildXlsx } from "@/lib/xlsx";
import { ApiError, handler, requireFestAccess, requirePermission } from "@/server/api";
import { RATE_LIMITS } from "@/server/rate-limit";
import { buildTablePdf } from "@/server/export-pdf";
import { tableToCsv } from "@/core/services/registration-export";
import { COLLECTIONS, adminDb } from "@/server/firebase-admin";
import { loadFestAnalytics, loadPlatformAnalytics, type FestAnalyticsBundle, type PlatformAnalyticsBundle } from "@/server/fest-analytics";

/**
 * GET /api/admin/analytics/export — the Export Center.
 *
 * Same one-route-three-formats shape as the registration export: the report
 * table is built exactly once, and each format is a different serialization
 * of it. There is no charting library in this project (`lib/zip.ts` and
 * `lib/xlsx.ts` are hand-rolled, dependency-free writers), so "charts" in
 * the exported report are the same series a chart would draw, as numbers —
 * a spreadsheet a college's accounts office opens is better served by a
 * number it can total than an image it cannot.
 */
const querySchema = z.object({
  scope: z.enum(["fest", "platform"]).default("fest"),
  festId: z.string().min(1).optional(),
  eventId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  format: z.enum(["csv", "xlsx", "pdf"]).default("csv"),
});

const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);

const festReportRows = (name: string, bundle: FestAnalyticsBundle): (string | number)[][] => {
  const rows: (string | number)[][] = [
    ["KPI Summary", ""],
    ["Fest", name],
    ["Total events", bundle.overview.events],
    ["Total registrations", bundle.overview.registrations],
    ["Total students", bundle.overview.students],
    ["Total volunteers", bundle.overview.volunteers],
    ["Certificates issued", bundle.overview.certificatesIssued],
    ["Attendance %", pct(bundle.overview.attendanceRate)],
    ["Waitlist conversion %", pct(bundle.overview.waitlistConversionRate)],
    ["", ""],
    ["Registrations by event", "Count"],
    ...bundle.eventWiseRegistrations.map((e) => [e.eventTitle, e.count]),
    ["", ""],
    ["Registrations per day", "Seats"],
    ...bundle.dailyRegistrations.map((p) => [p.label, p.value]),
    ["", ""],
    ["Capacity utilization", "Registered / Capacity"],
    ...bundle.capacityUtilization.map((c) => [c.title, `${c.registered} / ${c.capacity} (${pct(c.rate)})`]),
    ["", ""],
    ["College distribution", "Count"],
    ...bundle.distributions.college.top.map((d) => [d.label, d.count]),
    ...(bundle.distributions.college.others > 0 ? [[`Others (${bundle.distributions.college.otherGroups})`, bundle.distributions.college.others]] : []),
    ["", ""],
    ["Attendance", ""],
    ["Registered", bundle.attendance.registered],
    ["Checked in", bundle.attendance.checkedIn],
    ["No-shows", bundle.attendance.noShow],
    ["", ""],
    ["Volunteer leaderboard", "Total scans"],
    ...bundle.volunteerLeaderboard.map((v) => [v.name || v.userId, v.totalScans]),
    ["", ""],
    ["Certificates", ""],
    ["Eligible", bundle.certificates.eligible],
    ["Released", bundle.certificates.released],
    ["Downloaded", bundle.certificates.downloaded],
    ["Email delivered", bundle.certificates.emailDelivered],
    ["Verification requests", bundle.certificates.verificationCount],
    ["", ""],
    ["Live matches", ""],
    ["Total matches", bundle.live.matches.total],
    ["Live now", bundle.live.matches.live],
    ["Completed", bundle.live.matches.completed],
    ["Average duration (minutes)", bundle.live.matches.avgDurationMinutes === null ? "—" : Math.round(bundle.live.matches.avgDurationMinutes)],
    ["", ""],
    ["Arena utilization", "Matches"],
    ...bundle.live.arenaUtilization.map((a) => [a.arenaName, a.matchCount]),
    ["", ""],
    ["Most active volunteers (live scoring)", "Actions"],
    ...bundle.live.mostActiveVolunteers.slice(0, 10).map((v) => [v.name, v.actionCount]),
    ["", ""],
    ["Team win rate", "W-L"],
    ...bundle.live.teamWinRate.slice(0, 10).map((t) => [t.name, `${t.wins}-${t.losses}`]),
  ];
  return rows;
};

const platformReportRows = (bundle: PlatformAnalyticsBundle): (string | number)[][] => [
  ["KPI Summary (platform)", ""],
  ["Total fests", bundle.overview.fests],
  ["Total events", bundle.overview.events],
  ["Total registrations", bundle.overview.registrations],
  ["Total students", bundle.overview.students],
  ["Total volunteers", bundle.overview.volunteers],
  ["Certificates issued", bundle.overview.certificatesIssued],
  ["Certificates released", bundle.overview.certificatesReleased],
  ["Certificates downloaded", bundle.overview.certificatesDownloaded],
  ["Certificate verifications", bundle.overview.certificateVerifications],
  ["Attendance %", pct(bundle.overview.attendanceRate)],
  ["Waitlist conversion %", pct(bundle.overview.waitlistConversionRate)],
  ["Active users (30 days)", bundle.overview.activeUsers30d],
  ["", ""],
  ["Registrations by fest", "Count"],
  ...bundle.festWiseRegistrations.map((f) => [f.festName, f.count]),
  ["", ""],
  ["Registrations per day", "Seats"],
  ...bundle.dailyRegistrations.map((p) => [p.label, p.value]),
  ["", ""],
  ["College distribution", "Count"],
  ...bundle.distributions.college.top.map((d) => [d.label, d.count]),
];

export const GET = handler(
  async (request) => {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw ApiError.badRequest("Bad export request.");
    const { scope, festId, eventId, from, to, format } = parsed.data;

    let title: string;
    let filenameBase: string;
    let rows: (string | number)[][];

    if (scope === "platform") {
      await requirePermission(request, "platform:manage");
      const bundle = await loadPlatformAnalytics({ from, to });
      rows = platformReportRows(bundle);
      title = "Plansphere — platform analytics";
      filenameBase = "platform-analytics";
    } else {
      if (!festId) throw ApiError.badRequest("festId is required for a fest-scoped export.");
      const caller = await requirePermission(request, "audit:read");
      requireFestAccess(caller, festId);
      const fest = await adminDb().collection(COLLECTIONS.fests).doc(festId).get();
      if (!fest.exists) throw ApiError.notFound("That fest no longer exists.");
      const festName = String(fest.data()?.name ?? festId);
      const bundle = await loadFestAnalytics(festId, { eventId, range: { from, to } });
      rows = festReportRows(festName, bundle);
      title = `${festName} — analytics report`;
      filenameBase = `${fest.data()?.slug ?? "fest"}-analytics`;
    }

    const headers = ["Metric", "Value"];

    if (format === "csv") {
      const csv = "﻿" + tableToCsv(headers, rows);
      return new Response(csv, {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filenameBase}.csv"` },
      });
    }

    if (format === "xlsx") {
      const bytes = buildXlsx("Analytics", headers, rows);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filenameBase}.xlsx"`,
        },
      });
    }

    const pdf = await buildTablePdf({
      title,
      subtitle: `Exported ${new Date().toLocaleDateString("en-GB")}`,
      headers,
      rows,
    });
    return new Response(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filenameBase}.pdf"` },
    });
  },
  { rateLimit: RATE_LIMITS.authenticated.exports },
);
