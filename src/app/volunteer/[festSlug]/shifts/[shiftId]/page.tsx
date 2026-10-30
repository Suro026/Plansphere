"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Check } from "@phosphor-icons/react";
import { useVolunteerFest } from "@/components/shell/volunteer-shell";
import { useDeviceActivity, useMyShifts } from "@/components/volunteer/use-my-shifts";
import { Button } from "@/components/ui/button";
import { EmptyState, Kick, MetaList, MetaRow, Skeleton, Tag } from "@/components/ui/primitives";
import { SHIFT_DUTY_LABELS, shiftPhase } from "@/core/models/shift";
import { formatCalendarDate, formatClock } from "@/lib/utils";

/** 5a — shift detail: the facts, what you can and cannot do, checklist, your last scans. */
export default function ShiftDetailPage() {
  const { fest, basePath } = useVolunteerFest();
  const { shiftId } = useParams<{ shiftId: string }>();
  const my = useMyShifts(fest.id);
  const shift = my.shifts.find((s) => s.id === shiftId);
  const event = shift ? my.eventFor(shift) : null;
  const device = useDeviceActivity(event?.id);

  if (my.loading) {
    return (
      <div className="px-[18px] pt-3">
        <Skeleton className="mb-4 h-6 w-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (!shift) {
    return (
      <div className="px-[18px] pt-6">
        <EmptyState title="Shift not found" body="It may have been removed from the roster." action={<Button asChild variant="secondary"><Link href={basePath}>My shifts</Link></Button>} />
      </div>
    );
  }

  const phase = shiftPhase(shift, my.now);
  const start = new Date(`${shift.date}T${shift.startTime}:00`).getTime();
  const end = new Date(`${shift.date}T${shift.endTime}:00`).getTime();
  const scansInShift = device.history.filter((h) => h.outcome === "ok" && h.at >= start && h.at <= end);
  const openedScanner = device.history.some((h) => h.at >= start - 3600_000);
  const q = new URLSearchParams();
  if (shift.duty === "meal") q.set("mode", "meal");
  if (shift.post) q.set("gate", shift.post);
  if (shift.eventIds[0]) q.set("eventId", shift.eventIds[0]);
  const scanHref = `${basePath}/scan?${q.toString()}`;

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-76px)] w-full max-w-[720px] flex-col sm:min-h-0">
      <div className="px-[18px] pt-2.5 sm:px-6 sm:pt-6">
        <Link href={basePath} className="btn btn-ghost pl-0 text-[12.5px]">
          ← Shifts
        </Link>
        <div className="my-2 flex gap-[7px]">
          {phase === "active" ? <Tag tone="accent">On shift now</Tag> : phase === "upcoming" ? <Tag tone="neutral">Upcoming</Tag> : <Tag tone="neutral">Completed</Tag>}
          <Tag tone="neutral">{shift.duty === "meal" ? "Meal mode" : shift.duty === "entry" ? "Entry mode" : "No scanning"}</Tag>
        </div>
        <div className="text-[23px] font-medium leading-[1.1] tracking-[-0.02em]">
          {shift.post} · {SHIFT_DUTY_LABELS[shift.duty].toLowerCase()}
        </div>
      </div>

      <div className="flex-1 px-[18px] pt-4 sm:px-6">
        <MetaList>
          <MetaRow label="Event">{event ? event.title : "Whole fest"}</MetaRow>
          <MetaRow label="Window">
            {shift.date === my.today ? "" : `${formatCalendarDate(shift.date)} · `}
            {shift.startTime} – {shift.endTime}
          </MetaRow>
          <MetaRow label="Post">{shift.post}{event ? `, ${event.venue}` : ""}</MetaRow>
          {shift.coordinatorName ? <MetaRow label="Coordinator">{shift.coordinatorName}</MetaRow> : null}
          <MetaRow label="Your role">Organizer · scoped to {shift.eventIds.length ? "this event" : "this fest"}</MetaRow>
          <MetaRow label="You can">{shift.duty === "entry" ? `Scan entry at ${shift.post}` : shift.duty === "meal" ? `Serve meals at ${shift.post}` : "Direct people, answer questions"}</MetaRow>
          <MetaRow label="You cannot">Mark manual entry, edit registrations</MetaRow>
        </MetaList>

        <div className="pt-[18px]">
          <Kick className="mb-[9px]">Checklist</Kick>
          <div className="flex flex-col gap-2 text-[13px]">
            <CheckItem done={phase !== "upcoming" && scansInShift.length > 0} label="Checked in for your shift" />
            <CheckItem done={openedScanner} label="Scanner opened once" />
            <CheckItem done={phase === "completed"} label={`Hand over at ${shift.endTime}`} />
          </div>
        </div>

        {shift.duty !== "crowd" ? (
          <div className="pt-[18px]">
            <Kick className="mb-[9px]">Your last scans</Kick>
            {device.history.length === 0 ? (
              <div className="text-[12.5px] text-neutral-500">Nothing scanned on this device yet.</div>
            ) : (
              <MetaList>
                {device.history.slice(0, 6).map((h) => (
                  <MetaRow key={h.id} label={`${formatClock(new Date(h.at))} · ${h.userName}`}>
                    <span className={h.outcome === "ok" ? "" : "text-neutral-500"}>
                      {h.outcome === "ok" ? (h.queued ? "Accepted · queued" : "Accepted") : h.outcome === "already-recorded" ? "Already in" : h.outcome === "not-found" ? "Invalid" : h.outcome}
                    </span>
                  </MetaRow>
                ))}
              </MetaList>
            )}
          </div>
        ) : null}
      </div>

      <div className="flex gap-[9px] border-t border-divider px-[18px] pb-[22px] pt-3.5 sm:px-6">
        <Button asChild variant="secondary" className="flex-1">
          <a href={fest.contactPhone ? `tel:${fest.contactPhone}` : fest.contactEmail ? `mailto:${fest.contactEmail}` : `${basePath}/team`}>Need help</a>
        </Button>
        {shift.duty !== "crowd" ? (
          <Button asChild variant="primary" className="flex-1">
            <Link href={scanHref}>Open scanner</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

const CheckItem = ({ done, label }: { done: boolean; label: string }) => (
  <div className={`flex items-center gap-[9px] ${done ? "text-accent" : "text-neutral-600"}`}>
    {done ? <Check size={15} weight="bold" className="flex-none" /> : <span className="h-[15px] w-[15px] flex-none rounded-full shadow-[inset_0_0_0_1.5px_currentColor]" />}
    <span className={done ? "text-text" : "text-neutral-300"}>{label}</span>
  </div>
);
