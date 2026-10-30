"use client";

import * as React from "react";
import Link from "next/link";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { downloadAnalyticsExport, useFestAnalytics, type Distribution } from "@/components/admin/analytics-api";
import { HeatRow, LineArea } from "@/components/admin/charts";
import { Seg } from "@/components/ui/field";
import { Bar, EmptyState, Kick, Kpi, KpiStrip, MetaList, MetaRow, PageHeading, Panel, Skeleton } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { formatCount, formatPercent } from "@/lib/utils";

type Range = "7" | "30" | "90" | "all";

const RANGE_DAYS: Record<Range, number | null> = { "7": 7, "30": 30, "90": 90, all: null };

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
 * 6 — Fest-wide analytics: dashboard overview, registration, student,
 * attendance and certificate analytics, plus the export center's fest scope.
 *
 * Driven entirely by `/api/admin/analytics`, not raw client subscriptions:
 * this page must stay fast at 10k+ registrations, which means `count()`
 * aggregation and reads bounded to the chosen range rather than every
 * document in the fest streamed into the browser. "Live" sets a 10-second
 * refetch interval on the same bounded query rather than opening an
 * unbounded `onSnapshot` on the whole collection — the freshness the spec
 * asks for, without the cost a raw listener would carry at that scale.
 */
export default function FestAnalyticsPage() {
  const { fest } = useFest();
  const [range, setRange] = React.useState<Range>("30");
  const [live, setLive] = React.useState(false);

  const { from, to } = React.useMemo(() => {
    const days = RANGE_DAYS[range];
    const now = new Date();
    return days ? { from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000), to: now } : { from: undefined, to: undefined };
  }, [range]);

  const analytics = useFestAnalytics(fest.id, { from, to });

  React.useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void analytics.refetch(), 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch identity is stable enough for a polling tick
  }, [live, fest.id, range]);

  const [exportBusy, setExportBusy] = React.useState<"csv" | "xlsx" | "pdf" | null>(null);
  const runExport = async (format: "csv" | "xlsx" | "pdf") => {
    setExportBusy(format);
    try {
      await downloadAnalyticsExport({ scope: "fest", festId: fest.id, from, to, format });
    } finally {
      setExportBusy(null);
    }
  };

  if (analytics.isPending) {
    return (
      <AdminPage className="pb-9 pt-[26px]">
        <Skeleton className="mb-6 h-10 w-[280px]" />
        <Skeleton className="mb-6 h-[92px]" />
        <Skeleton className="h-64" />
      </AdminPage>
    );
  }

  if (analytics.isError || !analytics.data) {
    return (
      <AdminPage className="pb-9 pt-[26px]">
        <EmptyState
          title="Couldn't load analytics"
          body="This reads aggregated figures from the server. Try again in a moment."
          action={
            <Button variant="secondary" onClick={() => analytics.refetch()}>
              Try again
            </Button>
          }
        />
      </AdminPage>
    );
  }

  const a = analytics.data;

  return (
    <AdminPage className="pb-9 pt-[26px]">
      <PageHeading
        kick={fest.name}
        title="Analytics"
        actions={
          <>
            <Seg
              value={range}
              onChange={setRange}
              options={[
                { value: "7", label: "7d" },
                { value: "30", label: "30d" },
                { value: "90", label: "90d" },
                { value: "all", label: "All" },
              ]}
              aria-label="Date range"
            />
            <Seg
              value={live ? "on" : "off"}
              onChange={(v) => setLive(v === "on")}
              options={[
                { value: "off", label: "Static" },
                { value: "on", label: "Live" },
              ]}
              aria-label="Live mode"
            />
          </>
        }
        className="mb-5"
      />

      <KpiStrip className="mb-7">
        <Kpi value={formatCount(a.overview.events)} label="Events" />
        <Kpi value={formatCount(a.overview.registrations)} label="Registrations" />
        <Kpi value={formatCount(a.overview.students)} label="Students" />
        <Kpi value={formatCount(a.overview.volunteers)} label="Volunteers" />
        <Kpi value={formatCount(a.overview.certificatesIssued)} label="Certificates" />
        <Kpi value={a.overview.attendanceRate === null ? "—" : formatPercent(a.attendance.checkedIn, a.attendance.registered)} label="Attendance" />
        <Kpi value={a.overview.waitlistConversionRate === null ? "—" : `${Math.round(a.overview.waitlistConversionRate * 100)}%`} label="Waitlist conv." />
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
          <Kick className="mb-3">Team vs. individual</Kick>
          <div className="flex flex-col gap-3">
            <MetaRow label="Individual" mono>
              {formatCount(a.teamVsIndividual.individual)}
            </MetaRow>
            <Bar value={a.teamVsIndividual.individual / Math.max(1, a.teamVsIndividual.individual + a.teamVsIndividual.team)} />
            <MetaRow label="Team" mono>
              {formatCount(a.teamVsIndividual.team)}
            </MetaRow>
          </div>
        </Panel>

        <Panel className="p-5">
          <Kick className="mb-3">Registrations by event</Kick>
          {a.eventWiseRegistrations.length === 0 ? (
            <div className="text-[12.5px] text-neutral-500">No registrations yet.</div>
          ) : (
            <MetaList>
              {a.eventWiseRegistrations.slice(0, 10).map((e) => (
                <MetaRow key={e.eventId} label={e.eventTitle} mono>
                  {formatCount(e.count)}
                </MetaRow>
              ))}
            </MetaList>
          )}
        </Panel>
        <Panel className="p-5">
          <Kick className="mb-3">Capacity utilization</Kick>
          {a.capacityUtilization.length === 0 ? (
            <div className="text-[12.5px] text-neutral-500">No capped events.</div>
          ) : (
            <MetaList>
              {a.capacityUtilization.slice(0, 10).map((c) => (
                <MetaRow key={c.eventId} label={c.title} mono>
                  {c.registered}/{c.capacity} · {Math.round(c.rate * 100)}%
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
        <Panel className="p-5">
          <DistributionList title="Academic year" dist={a.distributions.academicYear} />
        </Panel>
        <Panel className="p-5">
          <DistributionList title="City" dist={a.distributions.city} />
        </Panel>
      </div>

      <Kick className="mb-3">Attendance analytics</Kick>
      <div className="mb-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Panel className="p-5">
          <MetaList>
            <MetaRow label="Registered" mono>
              {formatCount(a.attendance.registered)}
            </MetaRow>
            <MetaRow label="Checked in" mono>
              {formatCount(a.attendance.checkedIn)}
            </MetaRow>
            <MetaRow label="No-shows" mono>
              {formatCount(a.attendance.noShow)}
            </MetaRow>
          </MetaList>
        </Panel>
        <Panel className="p-5">
          <Kick className="mb-3">Entries by hour</Kick>
          <HeatRow cells={a.hourlyEntryTimeline} />
        </Panel>
        <Panel className="p-5">
          <Kick className="mb-3">Gate-wise scans</Kick>
          {a.gateWiseScans.length === 0 ? (
            <div className="text-[12.5px] text-neutral-500">No scans yet.</div>
          ) : (
            <MetaList>
              {a.gateWiseScans.map((g) => (
                <MetaRow key={g.gate} label={g.gate} mono>
                  {formatCount(g.count)}
                </MetaRow>
              ))}
            </MetaList>
          )}
        </Panel>
        <Panel className="p-5">
          <Kick className="mb-3">Volunteer leaderboard</Kick>
          {a.volunteerLeaderboard.length === 0 ? (
            <div className="text-[12.5px] text-neutral-500">No scans recorded yet.</div>
          ) : (
            <MetaList>
              {a.volunteerLeaderboard.slice(0, 10).map((v) => (
                <MetaRow key={v.userId} label={v.name || v.userId}>
                  <span className="code">{v.totalScans}</span>
                  <span className="ml-2 text-[11px] text-neutral-500">
                    {v.gateScans} gate · {v.foodScans} food
                  </span>
                </MetaRow>
              ))}
            </MetaList>
          )}
        </Panel>
      </div>

      <Kick className="mb-3">Certificate analytics</Kick>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Panel className="p-5">
          <KpiStrip>
            <Kpi value={formatCount(a.certificates.eligible)} label="Eligible" />
            <Kpi value={formatCount(a.certificates.released)} label="Released" />
            <Kpi value={formatCount(a.certificates.downloaded)} label="Downloaded" />
            <Kpi value={formatCount(a.certificates.emailDelivered)} label="Emailed" />
            <Kpi value={formatCount(a.certificates.verificationCount)} label="Verifications" />
          </KpiStrip>
        </Panel>
        <Panel className="p-5">
          <Kick className="mb-3">Downloads & verifications over time</Kick>
          <LineArea points={a.certificateDownloadsOverTime} />
        </Panel>
      </div>

      {a.live.matches.total > 0 ? (
        <>
          <Kick className="mb-3 mt-8">Live Event Engine</Kick>
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
            <Panel className="p-5">
              <KpiStrip>
                <Kpi value={formatCount(a.live.matches.total)} label="Total matches" />
                <Kpi value={formatCount(a.live.matches.live)} label="Live now" />
                <Kpi value={formatCount(a.live.matches.completed)} label="Completed" />
                <Kpi value={a.live.matches.avgDurationMinutes === null ? "—" : `${Math.round(a.live.matches.avgDurationMinutes)}m`} label="Avg. duration" />
              </KpiStrip>
            </Panel>
            <Panel className="p-5">
              <Kick className="mb-3">Arena utilization</Kick>
              {a.live.arenaUtilization.length === 0 ? (
                <div className="text-[12.5px] text-neutral-500">No arenas assigned yet.</div>
              ) : (
                <MetaList>
                  {a.live.arenaUtilization.map((row) => (
                    <MetaRow key={row.arenaId} label={row.arenaName} mono>
                      {formatCount(row.matchCount)}
                    </MetaRow>
                  ))}
                </MetaList>
              )}
            </Panel>
            <Panel className="p-5">
              <Kick className="mb-3">Most active volunteers</Kick>
              {a.live.mostActiveVolunteers.length === 0 ? (
                <div className="text-[12.5px] text-neutral-500">No scoring recorded yet.</div>
              ) : (
                <MetaList>
                  {a.live.mostActiveVolunteers.slice(0, 10).map((v) => (
                    <MetaRow key={v.userId} label={v.name} mono>
                      {formatCount(v.actionCount)}
                    </MetaRow>
                  ))}
                </MetaList>
              )}
            </Panel>
            <Panel className="p-5">
              <Kick className="mb-3">Team win rate</Kick>
              {a.live.teamWinRate.length === 0 ? (
                <div className="text-[12.5px] text-neutral-500">No completed matches yet.</div>
              ) : (
                <MetaList>
                  {a.live.teamWinRate.slice(0, 10).map((t) => (
                    <MetaRow key={t.registrationId} label={t.name} mono>
                      {t.wins}-{t.losses}
                    </MetaRow>
                  ))}
                </MetaList>
              )}
            </Panel>
          </div>
        </>
      ) : null}
    </AdminPage>
  );
}
