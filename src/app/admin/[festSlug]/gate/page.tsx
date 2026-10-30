"use client";

import * as React from "react";
import Link from "next/link";
import { QrCode } from "@phosphor-icons/react";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { useFestEvents, useFestGateFeed, useFestShifts } from "@/components/admin/hooks";
import { Button } from "@/components/ui/button";
import { EmptyState, Kick, Kpi, KpiStrip, MetaList, MetaRow, Note, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import { shiftPhase } from "@/core/models/shift";
import { formatClock, formatRelative } from "@/lib/utils";

/**
 * Gate — in the admin nav of every canvas screen but never drawn. The live
 * picture of the doors: today's throughput per event, who is scanning where
 * and when they last did, and the launchers for the scanner itself.
 */
export default function GatePage() {
  const { fest, basePath } = useFest();
  const events = useFestEvents(fest.id);
  const feed = useFestGateFeed(fest.id, 2000);
  const shifts = useFestShifts(fest.id);

  const now = React.useMemo(() => new Date(), [feed.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = now.toISOString().slice(0, 10);
  const todayScans = React.useMemo(() => (feed.data ?? []).filter((a) => a.scannedAt.toISOString().slice(0, 10) === today), [feed.data, today]);
  const lastHour = todayScans.filter((a) => now.getTime() - a.scannedAt.getTime() < 3600_000).length;

  const live = (events.data ?? []).filter((e) => e.date === today && e.status !== "cancelled" && e.status !== "draft");

  const byEvent = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const a of todayScans) m.set(a.eventId, (m.get(a.eventId) ?? 0) + 1);
    return m;
  }, [todayScans]);

  // Devices = distinct scanners today, with their last scan.
  const devices = React.useMemo(() => {
    const m = new Map<string, { name: string; gate?: string; last: Date; count: number }>();
    for (const a of todayScans) {
      const cur = m.get(a.scannedBy);
      if (!cur || a.scannedAt > cur.last) m.set(a.scannedBy, { name: a.scannedByName ?? "Volunteer", gate: a.gate, last: a.scannedAt, count: (cur?.count ?? 0) + 1 });
      else cur.count += 1;
    }
    return [...m.values()].sort((a, b) => b.last.getTime() - a.last.getTime());
  }, [todayScans]);

  const onShift = (shifts.data ?? []).filter((s) => shiftPhase(s, now) === "active");

  return (
    <>
      <AdminPage className="pb-[18px] pt-[26px]">
        <PageHeading
          title="Gate"
          sub={`${fest.name} · ${live.length} event${live.length === 1 ? "" : "s"} today · ${onShift.length} on shift${feed.updatedAt ? ` · feed live ${formatRelative(feed.updatedAt)}` : ""}`}
          actions={
            <Button asChild variant="primary">
              <Link href={`/scan?fest=${fest.slug}`}>
                <QrCode size={16} /> Open scanner
              </Link>
            </Button>
          }
        />
      </AdminPage>

      <KpiStrip className="mx-auto w-full max-w-[1180px]">
        <Kpi value={todayScans.length.toLocaleString("en-IN")} label="Check-ins today" />
        <Kpi value={lastHour} label="Last hour" />
        <Kpi value={devices.length} label="Scanners active today" />
        <Kpi value={fest.stats.checkIns.toLocaleString("en-IN")} label="Fest total" />
      </KpiStrip>

      <AdminPage className="grid gap-[34px] pb-9 pt-[26px] lg:grid-cols-[1fr_320px]">
        <div>
          <h4 className="mb-3">Events today</h4>
          {events.loading ? (
            <Skeleton className="h-40" />
          ) : live.length === 0 ? (
            <EmptyState title="Nothing scheduled today" body="The gate view fills in on event days. Scanners can still be opened for any published event." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Start</th>
                    <th>Gates</th>
                    <th>Registered</th>
                    <th>Checked in</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {live.map((e) => (
                    <tr key={e.id}>
                      <td>{e.title}</td>
                      <td>{e.startTime}</td>
                      <td>{e.gates.length ? e.gates.join(", ") : <span className="text-neutral-500">none named</span>}</td>
                      <td>{e.registeredCount}</td>
                      <td>{byEvent.get(e.id) ?? 0}</td>
                      <td className="whitespace-nowrap text-right">
                        <Link href={`/scan?fest=${fest.slug}&event=${e.slug}&mode=entry`} className="btn btn-ghost text-[12px]">
                          Entry
                        </Link>
                        {e.mealSlots.length ? (
                          <Link href={`/scan?fest=${fest.slug}&event=${e.slug}&mode=meal`} className="btn btn-ghost text-[12px]">
                            Meals
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-6">
            <Kick className="mb-2.5">Live feed</Kick>
            {feed.loading ? (
              <Skeleton className="h-32" />
            ) : todayScans.length === 0 ? (
              <div className="text-[12.5px] text-neutral-500">No scans yet today.</div>
            ) : (
              <MetaList>
                {todayScans.slice(0, 20).map((a) => (
                  <MetaRow key={a.id} label={`${formatClock(a.scannedAt)}${a.gate ? ` · ${a.gate}` : ""}`}>
                    {a.userName}
                    {a.method === "manual" ? <span className="text-neutral-500"> · manual</span> : null}
                  </MetaRow>
                ))}
              </MetaList>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-5">
          <div>
            <Kick className="mb-2.5">Devices</Kick>
            {devices.length === 0 ? (
              <div className="text-[12.5px] text-neutral-500">Nobody has scanned yet today.</div>
            ) : (
              <MetaList>
                {devices.map((d) => {
                  const stale = now.getTime() - d.last.getTime() > 10 * 60_000;
                  return (
                    <MetaRow key={d.name + d.last.getTime()} label={`${d.gate ?? "—"} · ${d.name.split(/\s+/)[0]}`} emphasis={stale}>
                      {stale ? `Quiet since ${formatClock(d.last)}` : `Active · ${d.count} today`}
                    </MetaRow>
                  );
                })}
              </MetaList>
            )}
          </div>
          <div>
            <Kick className="mb-2.5">On shift now</Kick>
            {onShift.length === 0 ? (
              <div className="text-[12.5px] text-neutral-500">
                No active shifts. <Link href={`${basePath}/volunteers`}>Roster volunteers</Link>
              </div>
            ) : (
              <MetaList>
                {onShift.map((s) => (
                  <MetaRow key={s.id} label={s.post}>
                    {s.userName.split(/\s+/)[0]} · until {s.endTime}
                  </MetaRow>
                ))}
              </MetaList>
            )}
          </div>
          <Note title="A second scan is refused, not double counted">
            Check-in documents are keyed by the entry, so the same ticket cannot be recorded twice — by two devices or by one device offline and again online.{" "}
            <Tag tone="neutral" className="ml-1">Manual override</Tag> lives on Registrations and is admin-only.
          </Note>
        </div>
      </AdminPage>
    </>
  );
}
