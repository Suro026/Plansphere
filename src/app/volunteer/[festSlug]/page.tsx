"use client";

import * as React from "react";
import Link from "next/link";
import { useAuth } from "@/components/providers";
import { useVolunteerFest } from "@/components/shell/volunteer-shell";
import { useDeviceActivity, useMyShifts } from "@/components/volunteer/use-my-shifts";
import { Button } from "@/components/ui/button";
import { Bar, EmptyState, Kick, MetaList, MetaRow, Note, Skeleton, StatusBanner, Tag } from "@/components/ui/primitives";
import { SHIFT_DUTY_LABELS, shiftPhase, shiftRemaining, type Shift } from "@/core/models/shift";
import { formatCalendarDate, formatClock } from "@/lib/utils";

const scanHref = (basePath: string, shift: Shift | null) => {
  if (!shift) return `${basePath}/scan`;
  const q = new URLSearchParams();
  if (shift.duty === "meal") q.set("mode", "meal");
  if (shift.post) q.set("gate", shift.post);
  if (shift.eventIds[0]) q.set("eventId", shift.eventIds[0]);
  return `${basePath}/scan?${q.toString()}`;
};

/**
 * 5a — the volunteer's day. One duty at a time, offline-safe, nothing they
 * can't act on. Phone: the card and today's list. Desktop: the same data as
 * the shifts table with the big "scans by you" figure.
 */
export default function VolunteerHomePage() {
  const { fest, basePath } = useVolunteerFest();
  const { profile } = useAuth();
  const my = useMyShifts(fest.id);
  const device = useDeviceActivity();

  const first = profile?.fullName?.split(/\s+/)[0] ?? "there";
  const dayIndex = Math.max(1, Math.round((new Date(my.today).getTime() - new Date(fest.startDate).getTime()) / 86400000) + 1);
  const shift = my.nextUp;
  const event = shift ? my.eventFor(shift) : null;
  const remaining = shift ? shiftRemaining(shift, my.now) : null;
  const progress = shift
    ? (() => {
        const s = new Date(`${shift.date}T${shift.startTime}:00`).getTime();
        const e = new Date(`${shift.date}T${shift.endTime}:00`).getTime();
        return Math.min(1, Math.max(0, (my.now.getTime() - s) / Math.max(1, e - s)));
      })()
    : 0;

  const phaseTag = (s: Shift) => {
    const p = shiftPhase(s, my.now);
    return p === "active" ? <Tag tone="accent">Now</Tag> : p === "upcoming" ? <Tag tone="neutral">Upcoming</Tag> : p === "completed" ? <Tag tone="neutral">Done</Tag> : <Tag tone="neutral">Cancelled</Tag>;
  };

  return (
    <div className="mx-auto w-full max-w-[1180px]">
      {/* Header */}
      <div className="px-[18px] pb-3.5 pt-2.5 sm:px-6 sm:pt-[26px] lg:px-8">
        <div className="flex items-end justify-between gap-3">
          <div>
            <Kick className="whitespace-nowrap">
              {fest.name} · {fest.startDate <= my.today && fest.endDate >= my.today ? `Day ${dayIndex}` : formatCalendarDate(my.today)}
            </Kick>
            <div className="mt-[3px] text-[20px] font-medium tracking-[-0.02em] sm:text-[25px]">
              <span className="sm:hidden">Hi, {first}</span>
              <span className="hidden sm:inline">My shifts</span>
            </div>
          </div>
          <Tag tone={my.active ? "accent" : "outline"} className="whitespace-nowrap">
            {my.active ? `On shift · ${my.active.post}` : "Volunteer"}
          </Tag>
        </div>
        {!device.online || device.pending > 0 ? (
          <StatusBanner className="mt-3" trailing={device.online ? "Syncing" : "Retrying"}>
            {device.online ? `${device.pending} scan${device.pending === 1 ? "" : "s"} waiting to sync` : `Offline — ${device.pending} scan${device.pending === 1 ? "" : "s"} queued`}
          </StatusBanner>
        ) : null}
      </div>

      {/* Desktop hero figure */}
      <div className="hidden px-6 sm:block lg:px-8">
        <div className="mb-[22px] flex items-end gap-9 pb-5 shadow-[inset_0_-1px_0_var(--color-divider)]">
          <div>
            <div className="text-[54px] font-medium leading-none tracking-[-0.035em]">{device.scansToday}</div>
            <div className="kpil mt-0.5">Scans by you today</div>
          </div>
          <div className="flex-1 pb-2">
            <Bar value={progress} height={6} />
            <div className="mt-2 flex justify-between text-[12px] text-neutral-500">
              <span>{shift ? (remaining ? `Shift ${remaining} remaining` : shiftPhase(shift, my.now) === "upcoming" ? `Starts ${shift.startTime}` : "Shift over") : "No shift scheduled"}</span>
              <span>{device.pending ? `${device.pending} queued offline` : device.lastSyncAt ? `Synced ${formatClock(device.lastSyncAt)}` : "Synced"}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Phone: current shift card */}
      <div className="px-[18px] sm:hidden">
        {my.loading ? (
          <Skeleton className="h-52" />
        ) : shift ? (
          <div className="panel overflow-hidden">
            <div className="px-[15px] pb-[13px] pt-3.5">
              <div className="mb-[7px] flex items-center justify-between">
                {phaseTag(shift)}
                <span className="text-[11.5px] text-neutral-500">{shiftPhase(shift, my.now) === "active" ? `ends ${shift.endTime}` : `${shift.startTime}–${shift.endTime}`}</span>
              </div>
              <div className="text-[17px] font-medium tracking-[-0.015em]">
                {shift.post} · {SHIFT_DUTY_LABELS[shift.duty].toLowerCase()}
              </div>
              <div className="mt-1 text-[12.5px] text-neutral-300">
                {event ? `${event.title} · ${event.venue}` : "Whole fest"}
              </div>
            </div>
            {shift.duty !== "crowd" ? (
              <div className="flex gap-2 px-[15px] pb-3.5">
                <Button asChild variant="primary" size="lg" className="flex-1">
                  <Link href={scanHref(basePath, shift)}>Quick scan</Link>
                </Button>
                <Button asChild variant="secondary" size="lg" className="flex-1">
                  <Link href={`${scanHref(basePath, shift)}${scanHref(basePath, shift).includes("?") ? "&" : "?"}search=1`}>Manual search</Link>
                </Button>
              </div>
            ) : null}
            <div className="flex gap-[22px] border-t border-divider px-[15px] pb-[13px] pt-[11px]">
              <div>
                <div className="text-[19px] font-medium">{device.scansToday}</div>
                <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-neutral-500">Scanned by you</div>
              </div>
              <div>
                <div className="text-[19px] font-medium">{remaining ?? (shiftPhase(shift, my.now) === "upcoming" ? shift.startTime : "—")}</div>
                <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-neutral-500">{remaining ? "Shift remaining" : "Starts"}</div>
              </div>
            </div>
          </div>
        ) : (
          <EmptyState title="No shift scheduled" body="When an admin rosters you, your post, duty and window show up here." />
        )}
      </div>

      {/* Shifts list / table */}
      <div className="px-[18px] pt-[18px] sm:px-6 sm:pt-0 lg:px-8">
        <Kick className="mb-[9px] sm:hidden">Today’s shifts</Kick>
        {my.loading ? null : my.shifts.length === 0 ? null : (
          <>
            <MetaList className="sm:hidden">
              {(my.todays.length ? my.todays : my.shifts).map((s) => (
                <Link key={s.id} href={`${basePath}/shifts/${s.id}`} className="no-underline text-inherit">
                  <MetaRow label={`${s.startTime}–${s.endTime} · ${s.post}`} emphasis={shiftPhase(s, my.now) === "active"}>
                    {shiftPhase(s, my.now) === "active" ? "Now" : SHIFT_DUTY_LABELS[s.duty].split(" ")[0]}
                  </MetaRow>
                </Link>
              ))}
            </MetaList>
            <div className="hidden table-wrap sm:block">
              <table className="table">
                <thead>
                  <tr>
                    <th>Window</th>
                    <th>Post</th>
                    <th>Duty</th>
                    <th>Event</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {my.shifts.map((s) => {
                    const ev = my.eventFor(s);
                    const p = shiftPhase(s, my.now);
                    return (
                      <tr key={s.id}>
                        <td className="whitespace-nowrap">
                          {s.date === my.today ? "" : `${formatCalendarDate(s.date)} · `}
                          {s.startTime}–{s.endTime}
                        </td>
                        <td>{s.post}</td>
                        <td>{SHIFT_DUTY_LABELS[s.duty]}</td>
                        <td>{s.eventIds.length === 0 ? "Whole fest" : (ev?.title ?? "—")}</td>
                        <td>{phaseTag(s)}</td>
                        <td className="whitespace-nowrap text-right">
                          {p === "active" && s.duty !== "crowd" ? (
                            <Link href={scanHref(basePath, s)} className="btn btn-ghost text-[12px]">
                              Scanner
                            </Link>
                          ) : null}
                          <Link href={`${basePath}/shifts/${s.id}`} className="btn btn-ghost text-[12px]">
                            Details
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        {shift?.notes || shift?.coordinatorName ? (
          <div className="pt-4">
            <Kick className="mb-[9px]">Notes from coordinators</Kick>
            <div className="panel px-[13px] py-3 text-[12.5px] text-neutral-300">
              {shift.coordinatorName ? <div className="mb-1 text-text">{shift.coordinatorName}</div> : null}
              {shift.notes ?? "Send anyone without a ticket to the help desk. Don’t mark manual entries yourself."}
            </div>
          </div>
        ) : null}

        <div className="hidden pt-5 sm:block">
          <Note title="What your account can do">
            A volunteer holds an organizer account — the lowest staff role — scoped to the posts and events on your roster. Scanning entry and meals is all it
            permits: manual entry, capacity changes and registration edits need at least admin, and every scan you take is logged against your account.
          </Note>
        </div>
      </div>
    </div>
  );
}
