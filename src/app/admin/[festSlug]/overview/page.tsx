"use client";

import * as React from "react";
import Link from "next/link";
import { useFest, AdminPage } from "@/components/shell/admin-shell";
import { useAuth, useRepositories } from "@/components/providers";
import { useFestCertificateCount, useFestEvents, useFestGateFeed, useFestMealCount } from "@/components/admin/hooks";
import { Seg } from "@/components/ui/field";
import { AnnounceDialog } from "@/components/admin/announce-dialog";
import { hasAtLeast } from "@/core/models/user";
import { Button } from "@/components/ui/button";
import {
  AnimatedList,
  Bar,
  EmptyState,
  Kick,
  Kpi,
  KpiStrip,
  MetaList,
  MetaRow,
  Note,
  PageHeading,
  Skeleton,
  Table,
  Tag,
} from "@/components/ui/primitives";
import type { Event } from "@/core/models/event";
import { formatClock, formatCount, formatDateRange, formatPercent, formatRelative } from "@/lib/utils";

const statusTag = (event: Event) => {
  switch (event.status) {
    case "ongoing":
      return <Tag tone="accent">Ongoing</Tag>;
    case "completed":
      return <Tag tone="neutral">Completed</Tag>;
    case "cancelled":
      return <Tag tone="neutral">Cancelled</Tag>;
    case "draft":
      return <Tag tone="outline">Draft</Tag>;
    default:
      return event.capacity > 0 && event.registeredCount >= event.capacity ? (
        <Tag tone="neutral">Full{event.waitlistEnabled ? " · waitlist" : ""}</Tag>
      ) : (
        <Tag tone="neutral">Published</Tag>
      );
  }
};

/** 2d — Fest owner dashboard. The sober, institutional half. */
export default function OverviewPage() {
  const { fest, basePath } = useFest();
  const { session } = useAuth();
  const events = useFestEvents(fest.id);
  const feed = useFestGateFeed(fest.id, 8);
  const meals = useFestMealCount(fest.id);
  const certificates = useFestCertificateCount(fest.id);

  const today = new Date().toISOString().slice(0, 10);
  const days = React.useMemo(() => {
    const out: string[] = [];
    const d = new Date(`${fest.startDate}T00:00:00`);
    const end = new Date(`${fest.endDate}T00:00:00`);
    while (d <= end && out.length < 14) {
      out.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }, [fest.startDate, fest.endDate]);

  const [day, setDay] = React.useState<string>(() => (days.includes(today) ? today : "all"));

  const all = events.data ?? [];
  const visible = day === "all" ? all : all.filter((e) => e.date === day);
  const revenue = all.reduce((sum, e) => sum + e.entryFee * e.registeredCount, 0);
  const checkIns = fest.stats.checkIns;
  const registrations = fest.stats.registrations;
  const dayIndex = Math.max(1, days.indexOf(today) + 1);
  const live = fest.startDate <= today && fest.endDate >= today;

  return (
    <>
      <AdminPage className="pb-[18px] pt-[26px]">
        <PageHeading
          size="lg"
          kick={`${fest.organizationName} · ${formatDateRange(fest.startDate, fest.endDate)}`}
          title="Overview"
          sub={
            live
              ? `Day ${dayIndex} of ${days.length} · live${events.updatedAt ? ` · all figures reconciled ${formatRelative(events.updatedAt)}` : ""}`
              : fest.startDate > today
                ? `Starts ${formatDateRange(fest.startDate, fest.startDate)} · ${all.length} events`
                : "Ended · figures are final"
          }
          actions={
            <>
              {session && hasAtLeast(session.role, "admin") ? <AnnounceDialog festId={fest.id} festName={fest.name} events={all} /> : null}
              <Button asChild variant="secondary">
                <Link href={`${basePath}/registrations`}>Registrations</Link>
              </Button>
              <Button asChild variant="primary">
                <Link href={`${basePath}/certificates`}>Issue certificates</Link>
              </Button>
            </>
          }
        />
      </AdminPage>

      <KpiStrip className="mx-auto w-full max-w-[1180px]">
        <AnimatedList stagger={35} className="flex">
          <Kpi value={registrations} label="Registrations" />
          <Kpi value={checkIns} label="Verified check-ins" />
          <Kpi value={formatPercent(checkIns, registrations)} label="Reg → check-in" />
          <Kpi value={meals.data === undefined ? "—" : meals.data} label="Meals served" />
          <Kpi value={certificates.data === undefined ? "—" : certificates.data} label="Certificates issued" />
          <Kpi value={revenue > 0 ? `₹${formatCount(revenue)}` : "₹0"} label="Listed entry fees" />
        </AnimatedList>
      </KpiStrip>

      <AdminPage className="grid gap-[34px] pb-9 pt-[26px] lg:grid-cols-[1fr_320px]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h4>{day === "all" ? "All events" : day === today ? "Events today" : `Events on ${formatDateRange(day, day)}`}</h4>
            {days.length > 1 ? (
              <div className="max-w-full overflow-x-auto scrollbar-none">
                <Seg
                  value={day}
                  onChange={setDay}
                  options={[
                    ...days.map((d, i) => ({ value: d, label: `Day ${i + 1}` })),
                    { value: "all", label: "All" },
                  ]}
                  aria-label="Which day"
                />
              </div>
            ) : null}
          </div>

          {events.loading ? (
            <Skeleton className="h-56" />
          ) : visible.length === 0 ? (
            <EmptyState
              title={all.length === 0 ? "No events yet" : "Nothing scheduled that day"}
              body={all.length === 0 ? "Create the first event and it appears here with live registration and check-in counts." : undefined}
              action={
                all.length === 0 ? (
                  <Button asChild variant="primary">
                    <Link href={`${basePath}/events/new`}>Create an event</Link>
                  </Button>
                ) : null
              }
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Start</th>
                  <th>Capacity</th>
                  <th>Registered</th>
                  <th>Checked in</th>
                  <th>Status</th>
                </tr>
              </thead>
              <AnimatedList as="tbody" variant="fade">
                {visible.map((event) => (
                  <EventRow key={event.id} event={event} basePath={basePath} />
                ))}
              </AnimatedList>
            </Table>
          )}
        </div>

        <div className="flex flex-col gap-5">
          <div>
            <Kick className="mb-2.5">Live gate feed</Kick>
            {feed.loading ? (
              <Skeleton className="h-32" />
            ) : feed.data && feed.data.length ? (
              <MetaList>
                {feed.data.map((a) => (
                  <MetaRow key={a.id} label={`${formatClock(a.scannedAt)}${a.gate ? ` · ${a.gate}` : ""}`}>
                    {a.userName}
                  </MetaRow>
                ))}
              </MetaList>
            ) : (
              <div className="text-[12.5px] text-neutral-500">No check-ins yet. The feed fills in as gates start scanning.</div>
            )}
          </div>
          <Note title="Audit trail on">
            Every override, role change and manual check-in is logged with the staff account that made it. Exports carry
            the same log for the college record.{" "}
            <Link href={`${basePath}/registrations#audit`}>View recent entries</Link>
          </Note>
        </div>
      </AdminPage>
    </>
  );
}

const EventRow = ({ event, basePath }: { event: Event; basePath: string }) => {
  const [checkedIn, setCheckedIn] = React.useState<number | null>(null);
  const repos = useRepositories();

  React.useEffect(() => {
    let cancelled = false;
    repos.attendance
      .countByEvent(event.id)
      .then((n) => !cancelled && setCheckedIn(n))
      .catch(() => !cancelled && setCheckedIn(0));
    return () => {
      cancelled = true;
    };
  }, [event.id, repos]);

  return (
    <tr>
      <td>
        <Link href={`${basePath}/events/${event.slug}/settings`} className="text-inherit no-underline hover:text-accent">
          {event.title}
        </Link>
      </td>
      <td>{event.startTime}</td>
      <td className="w-[110px]">{event.capacity > 0 ? <Bar value={event.registeredCount / event.capacity} /> : <span className="text-neutral-500">∞</span>}</td>
      <td>
        {event.registeredCount}
        {event.capacity > 0 ? ` / ${event.capacity}` : ""}
      </td>
      <td>{checkedIn === null ? "…" : checkedIn || "—"}</td>
      <td>{statusTag(event)}</td>
    </tr>
  );
};

