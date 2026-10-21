"use client";

import * as React from "react";
import Link from "next/link";
import { downloadAnalyticsExport, usePlatformAnalytics, type Distribution } from "@/components/admin/analytics-api";
import { HeatRow, LineArea } from "@/components/admin/charts";
import { Seg } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { EmptyState, Kick, Kpi, KpiStrip, MetaList, MetaRow, PageHeading, Panel, Skeleton } from "@/components/ui/primitives";
import { formatCount, formatPercent } from "@/lib/utils";

type Range = "7" | "30" | "90";
const RANGE_DAYS: Record<Range, number> = { "7": 7, "30": 30, "90": 90 };

const DistributionList = ({ title, dist }: { title: string; dist: Distribution }) => (
  <div>
    <Kick className="mb-2">{title}</Kick>
    {dist.total === 0 ? (
      <div className="text-[12.5px] text-neutral-500">Nothing recorded yet.</div>
    ) : (
      <MetaList>
        {dist.top.map((row) => (
          <MetaRow key={row.label} label={row.label} mono>
            {formatCount(row.count)} · {formatPercent(row.count, dist.total)}
          </MetaRow>
        ))}
        {dist.others > 0 ? (
          <MetaRow label={`Others (${dist.otherGroups})`} mono>
            {formatCount(dist.others)} · {formatPercent(dist.others, dist.total)}
          </MetaRow>
        ) : null}
      </MetaList>
    )}
  </div>
);

/**
 * 6/7/9 — Platform-wide analytics for the super admin.
 *
 * Everything here comes from `/api/admin/platform/analytics`: cross-fest
 * data can only ever come from a server route (a browser subscription would
 * have to read every registration on the platform to draw the same charts),
 * and the range is capped at 90 days for exactly the reason `fest-analytics`
 * documents — an unbounded platform-wide query is the one scan this module
 * exists to prevent.
 */
export default function PlatformAnalyticsPage() {
  const [range, setRange] = React.useState<Range>("30");
  const { from, to } = React.useMemo(() => {
    const now = new Date();
    return { from: new Date(now.getTime() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000), to: now };
  }, [range]);

  const analytics = usePlatformAnalytics({ from, to });

  const [exportBusy, setExportBusy] = React.useState<"csv" | "xlsx" | "pdf" | null>(null);
  const runExport = async (format: "csv" | "xlsx" | "pdf") => {
    setExportBusy(format);
    try {
      await downloadAnalyticsExport({ scope: "platform", from, to, format });
    } finally {
      setExportBusy(null);
    }
  };

  if (analytics.isPending) {
    return (
      <>
        <Skeleton className="mb-5 h-10 w-[280px]" />
        <Skeleton className="mb-6 h-[92px]" />
        <Skeleton className="h-64" />
      </>
    );
  }

  if (analytics.isError || !analytics.data) {
    return (
      <EmptyState
        title="Couldn't load platform analytics"
        body="This route reads aggregated figures across every fest. Try again in a moment."
        action={
          <Button variant="secondary" onClick={() => analytics.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  const a = analytics.data;

  return (
    <>
      <PageHeading
        kick="Platform"
        title="Analytics"
        actions={
          <Seg
            value={range}
            onChange={setRange}
            options={[
              { value: "7", label: "7d" },
              { value: "30", label: "30d" },
              { value: "90", label: "90d" },
            ]}
            aria-label="Date range"
          />
        }
        className="mb-5"
      />

      <KpiStrip className="mb-7">
        <Kpi value={formatCount(a.overview.fests)} label="Fests" />
        <Kpi value={formatCount(a.overview.events)} label="Events" />
        <Kpi value={formatCount(a.overview.registrations)} label="Registrations (range)" />
        <Kpi value={formatCount(a.overview.students)} label="Students" />
        <Kpi value={formatCount(a.overview.volunteers)} label="Volunteers" />
        <Kpi value={formatCount(a.overview.certificatesIssued)} label="Certificates" />
        <Kpi value={formatCount(a.overview.activeUsers30d)} label="Active (30d)" />
      </KpiStrip>

      <div className="mb-3.5 flex items-center justify-between">
        <Kick>Export this report</Kick>
        <div className="flex gap-1.5">
          {(["csv", "xlsx", "pdf"] as const).map((fmt) => (
            <Button key={fmt} variant="secondary" disabled={exportBusy !== null} onClick={() => void runExport(fmt)}>
              {exportBusy === fmt ? "Preparing…" : fmt.toUpperCase()}
            </Button>
          ))}
          <Button asChild variant="ghost">
            <Link href="/admin/reports">Full export center</Link>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 pb-8 lg:grid-cols-2">
        <Panel className="p-5">
          <Kick className="mb-3">Registrations over time (cumulative)</Kick>
          <LineArea points={a.registrationsOverTime} />
        </Panel>
        <Panel className="p-5">
          <Kick className="mb-3">Registrations per day</Kick>
          <LineArea points={a.dailyRegistrations} />
        </Panel>
        <Panel className="p-5">
          <Kick className="mb-3">Peak registration hour</Kick>
          <HeatRow cells={a.hourlyPeakRegistration} />
        </Panel>
        <Panel className="p-5">
          <Kick className="mb-3">Registrations by fest</Kick>
          {a.festWiseRegistrations.length === 0 ? (
            <div className="text-[12.5px] text-neutral-500">No registrations in this range.</div>
          ) : (
            <MetaList>
              {a.festWiseRegistrations.slice(0, 10).map((f) => (
                <MetaRow key={f.festId} label={f.festName} mono>
                  {formatCount(f.count)}
                </MetaRow>
              ))}
            </MetaList>
          )}
        </Panel>
      </div>

      <Kick className="mb-3">Student analytics</Kick>
      <div className="mb-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Panel className="p-5">
          <DistributionList title="College" dist={a.distributions.college} />
        </Panel>
        <Panel className="p-5">
          <DistributionList title="Department" dist={a.distributions.department} />
        </Panel>
      </div>

      <Kick className="mb-3">Certificate analytics</Kick>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Panel className="p-5">
          <KpiStrip>
            <Kpi value={formatCount(a.overview.certificatesIssued)} label="Eligible" />
            <Kpi value={formatCount(a.overview.certificatesReleased)} label="Released" />
            <Kpi value={formatCount(a.overview.certificatesDownloaded)} label="Downloaded" />
            <Kpi value={formatCount(a.overview.certificateVerifications)} label="Verifications" />
          </KpiStrip>
        </Panel>
        <Panel className="p-5">
          <Kick className="mb-3">Downloads & verifications over time</Kick>
          <LineArea points={a.certificateDownloadsOverTime} />
        </Panel>
      </div>
    </>
  );
}
