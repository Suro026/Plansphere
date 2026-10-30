"use client";

import * as React from "react";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { useAdminEvent } from "@/components/admin/event-context";
import { useEventAttendance, useFestAudit, useFestRegistrations } from "@/components/admin/hooks";
import { HeatRow, LineArea } from "@/components/admin/charts";
import { Seg } from "@/components/ui/field";
import { Bar, Kick, MetaList, MetaRow, Note, PageHeading, Skeleton, Timeline, TimelineItem } from "@/components/ui/primitives";
import { formatCalendarDate, formatClock, formatPercent } from "@/lib/utils";

type Window = "today" | "all";

/**
 * 4c — Event analytics. Hero turnout figure, registrations per day, check-ins
 * by hour, where participants came from, team sizes, and the live activity
 * rail. Every number is derived from the live registration and attendance
 * subscriptions — nothing here is a stored aggregate that can drift.
 */
export default function EventAnalyticsPage() {
  const { fest } = useFest();
  const { event } = useAdminEvent();
  const registrations = useFestRegistrations(event.festId, event.id);
  const attendance = useEventAttendance(event.id);
  const audit = useFestAudit(fest.id, 40);
  const [window_, setWindow] = React.useState<Window>("today");

  const regs = React.useMemo(() => (registrations.data ?? []).filter((r) => r.status !== "cancelled"), [registrations.data]);
  // Memoized because colleges/teamSizes/departments below key their own
  // useMemo on this array's identity — an unmemoized .filter() here would
  // hand them a new reference every render and defeat all three.
  const confirmed = React.useMemo(() => regs.filter((r) => r.status === "confirmed"), [regs]);
  const att = React.useMemo(() => attendance.data ?? [], [attendance.data]);
  const checkedIn = att.length;
  const registeredSeats = confirmed.reduce((s, r) => s + r.seats, 0);
  const noShows = Math.max(0, confirmed.length - checkedIn);
  const unfilled = event.capacity > 0 ? Math.max(0, event.capacity - event.registeredCount) : null;

  // Registrations per day, cumulative, from the first entry to the event.
  const perDay = React.useMemo(() => {
    if (regs.length === 0) return [];
    const days = new Map<string, number>();
    for (const r of regs) {
      const d = r.createdAt.toISOString().slice(0, 10);
      days.set(d, (days.get(d) ?? 0) + r.seats);
    }
    const sorted = [...days.keys()].sort();
    const start = new Date(`${sorted[0]}T00:00:00`);
    const end = new Date(`${(event.registrationDeadline ?? event.date) > (sorted.at(-1) ?? "") ? (event.registrationDeadline ?? event.date) : sorted.at(-1)}T00:00:00`);
    const out: Array<{ label: string; value: number }> = [];
    let running = 0;
    for (let d = new Date(start); d <= end && out.length < 120; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      running += days.get(key) ?? 0;
      out.push({ label: key, value: running });
    }
    return out;
  }, [regs, event.registrationDeadline, event.date]);

  // Check-ins by hour, 07:00–19:00 like the canvas, for today or all days.
  const today = new Date().toISOString().slice(0, 10);
  const hours = React.useMemo(() => {
    const cells = Array.from({ length: 13 }, (_, i) => ({ label: String(7 + i).padStart(2, "0"), value: 0 }));
    for (const a of att) {
      if (window_ === "today" && a.scannedAt.toISOString().slice(0, 10) !== today) continue;
      const h = a.scannedAt.getHours();
      const idx = h - 7;
      if (idx >= 0 && idx < 13) cells[idx]!.value += 1;
    }
    return cells;
  }, [att, window_, today]);

  // Where they came from: leader's college per confirmed entry.
  const colleges = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of confirmed) {
      const c = r.members.find((m) => m.isLeader)?.college ?? r.members[0]?.college ?? "Not stated";
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 4);
    const rest = sorted.slice(4).reduce((s, [, n]) => s + n, 0);
    return { top, rest, others: sorted.length - top.length, total: confirmed.length };
  }, [confirmed]);

  const teamSizes = React.useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of confirmed) counts.set(r.members.length, (counts.get(r.members.length) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[0] - a[0]);
  }, [confirmed]);

  // Department distribution — only meaningful once the fest or event asks
  // for one; most entries will land in "Not stated" until then.
  const departments = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of confirmed) {
      const d = r.answers?.department?.trim() || "Not stated";
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 4);
    const rest = sorted.slice(4).reduce((s, [, n]) => s + n, 0);
    return { top, rest, others: sorted.length - top.length, total: confirmed.length };
  }, [confirmed]);

  // Waitlist conversion: of everyone who has ever been on the waitlist for
  // this event (promoted, plus still waiting), how many made it in. Cancelled
  // waitlist entries are not counted either way — they never resolved.
  const waitlistConversion = React.useMemo(() => {
    const promoted = regs.filter((r) => r.promotedAt).length;
    const stillWaiting = regs.filter((r) => r.status === "waitlisted").length;
    const total = promoted + stillWaiting;
    return { promoted, stillWaiting, total, rate: total > 0 ? promoted / total : null };
  }, [regs]);

  const activity = React.useMemo(() => {
    const fromAudit = (audit.data ?? [])
      .filter((a) => a.eventId === event.id)
      .map((a) => ({ at: a.createdAt, title: a.summary, meta: `${formatClock(a.createdAt)} · ${a.actorName.split(/\s+/)[0]}`, live: false }));
    const fromScans = att.slice(0, 5).map((a, i) => ({
      at: a.scannedAt,
      title: `${checkedIn - i}${ordinal(checkedIn - i)} check-in recorded`,
      meta: `${formatClock(a.scannedAt)}${a.gate ? ` · ${a.gate}` : ""}`,
      live: i === 0,
    }));
    return [...fromAudit, ...fromScans].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 8);
  }, [audit.data, att, checkedIn, event.id]);

  const turnout = confirmed.length ? checkedIn / confirmed.length : 0;
  const loading = registrations.loading || attendance.loading;

  return (
    <>
      <AdminPage className="pb-5 pt-[26px]">
        <PageHeading
          kick={`${event.title} · ${formatCalendarDate(event.date)}`}
          title="Analytics"
          actions={
            <Seg
              value={window_}
              onChange={setWindow}
              options={[
                { value: "today", label: "Today" },
                { value: "all", label: "All days" },
              ]}
              aria-label="Check-in window"
            />
          }
        />
      </AdminPage>

      <AdminPage className="grid gap-8 pb-[34px] lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-[26px]">
          {loading ? (
            <Skeleton className="h-24" />
          ) : (
            <div className="flex flex-wrap items-end gap-x-10 gap-y-4 pb-[22px] shadow-[inset_0_-1px_0_var(--color-divider)]">
              <div>
                <div className="text-[54px] font-medium leading-none tracking-[-0.035em] sm:text-[66px]">{checkedIn}</div>
                <div className="kpil mt-0.5">Checked in of {confirmed.length} registered{registeredSeats !== confirmed.length ? ` (${registeredSeats} seats)` : ""}</div>
              </div>
              <div className="min-w-[220px] flex-1 pb-2">
                <Bar value={turnout} height={6} />
                <div className="mt-2 flex justify-between text-[12px] text-neutral-500">
                  <span>{formatPercent(checkedIn, confirmed.length)} turnout</span>
                  <span>
                    {noShows} no-show{noShows === 1 ? "" : "s"}
                    {unfilled !== null ? ` · ${unfilled} seats never filled` : ""}
                  </span>
                </div>
              </div>
            </div>
          )}

          <div>
            <div className="mb-3 flex items-center justify-between">
              <Kick>Registrations per day</Kick>
              <div className="text-[12px] text-neutral-500">
                {perDay.length ? `Opened ${formatCalendarDate(perDay[0]!.label)}` : "—"}
                {event.registrationDeadline ? ` · closes ${formatCalendarDate(event.registrationDeadline)}` : ""}
              </div>
            </div>
            <LineArea points={perDay} />
            {perDay.length >= 2 ? (
              <div className="mt-1 flex justify-between text-[11px] text-neutral-500">
                <span>{formatCalendarDate(perDay[0]!.label)}</span>
                <span>{formatCalendarDate(perDay[Math.floor(perDay.length / 2)]!.label)}</span>
                <span>{formatCalendarDate(perDay.at(-1)!.label)}</span>
              </div>
            ) : null}
          </div>

          <div>
            <Kick className="mb-3">Check-ins by hour{window_ === "today" ? " · today" : ""}</Kick>
            <HeatRow cells={hours} />
          </div>

          <div>
            <Kick className="mb-3">Where they came from</Kick>
            {colleges.total === 0 ? (
              <div className="text-[12.5px] text-neutral-500">No confirmed entries yet.</div>
            ) : (
              <MetaList>
                {colleges.top.map(([name, n]) => (
                  <MetaRow key={name} label={name === fest.organizationName ? `${name} (host)` : name}>
                    {n} {event.eventType === "team" ? "teams" : "entries"} · {formatPercent(n, colleges.total, 0)}
                  </MetaRow>
                ))}
                {colleges.rest > 0 ? (
                  <MetaRow label={`${colleges.others} other college${colleges.others === 1 ? "" : "s"}`}>{formatPercent(colleges.rest, colleges.total, 0)}</MetaRow>
                ) : null}
              </MetaList>
            )}
          </div>

          <div>
            <Kick className="mb-3">Department distribution</Kick>
            {departments.total === 0 ? (
              <div className="text-[12.5px] text-neutral-500">No confirmed entries yet.</div>
            ) : (
              <MetaList>
                {departments.top.map(([name, n]) => (
                  <MetaRow key={name} label={name}>
                    {n} {event.eventType === "team" ? "teams" : "entries"} · {formatPercent(n, departments.total, 0)}
                  </MetaRow>
                ))}
                {departments.rest > 0 ? (
                  <MetaRow label={`${departments.others} other department${departments.others === 1 ? "" : "s"}`}>{formatPercent(departments.rest, departments.total, 0)}</MetaRow>
                ) : null}
              </MetaList>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-[22px]">
          <div>
            <Kick className="mb-2.5">Live activity</Kick>
            {activity.length === 0 ? (
              <div className="text-[12.5px] text-neutral-500">Quiet so far. Check-ins and staff actions show up here as they happen.</div>
            ) : (
              <Timeline>
                {activity.map((a, i) => (
                  <TimelineItem key={`${a.at.getTime()}-${i}`} title={a.title} meta={a.meta} live={a.live} />
                ))}
              </Timeline>
            )}
          </div>
          <div>
            <Kick className="mb-2.5">Team vs individual</Kick>
            <MetaList>
              <MetaRow label={event.eventType === "team" ? "This is a team event" : "This is a solo event"}>
                {event.eventType === "team" ? `${confirmed.length} teams · ${registeredSeats} participants` : `${confirmed.length} participants`}
              </MetaRow>
            </MetaList>
          </div>
          {event.eventType === "team" ? (
            <div>
              <Kick className="mb-2.5">Team sizes</Kick>
              <MetaList>
                {teamSizes.map(([size, n]) => (
                  <MetaRow key={size} label={`${size} members`}>
                    {n} team{n === 1 ? "" : "s"}
                  </MetaRow>
                ))}
              </MetaList>
            </div>
          ) : null}
          <div>
            <Kick className="mb-2.5">Waitlist conversion</Kick>
            <MetaList>
              <MetaRow label={waitlistConversion.total === 0 ? "Nobody has been waitlisted" : "Promoted to a confirmed seat"}>
                {waitlistConversion.total === 0
                  ? "—"
                  : `${waitlistConversion.promoted} of ${waitlistConversion.total} (${formatPercent(waitlistConversion.promoted, waitlistConversion.total, 0)})`}
              </MetaRow>
              {waitlistConversion.stillWaiting > 0 ? (
                <MetaRow label="Still waiting">{waitlistConversion.stillWaiting}</MetaRow>
              ) : null}
            </MetaList>
          </div>
          <Note title={confirmed.length ? `${formatPercent(checkedIn, confirmed.length, 0)} of registered entries are through the gate` : "Waiting on the first check-in"}>
            Turnout is the number the college asks for afterwards. It is computed from verified scans only — a manual override
            counts, a screenshot does not.
          </Note>
        </div>
      </AdminPage>
    </>
  );
}

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"] as const;
  const v = n % 100;
  return s[(v - 20) % 10] ?? s[v] ?? s[0];
};
