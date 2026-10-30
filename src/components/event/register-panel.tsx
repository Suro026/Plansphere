"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { CalendarPlus } from "@phosphor-icons/react";
import type { Event } from "@/core/models/event";
import type { Fest } from "@/core/models/fest";
import { isRegistrationOpen, seatsRemaining } from "@/core/models/event";
import { useAuth, useRepositories } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, Sheet, SheetContent } from "@/components/ui/overlays";
import { Bar, MetaList, MetaRow, Note, Tag } from "@/components/ui/primitives";
import { formatCalendarDate, formatTeamSize } from "@/lib/utils";
import { RegistrationForm } from "./registration-form";
import { seatLine } from "./event-card";

/** Builds a calendar file the browser can open in the default calendar app. */
const icsHref = (event: Event, fest: Fest): string => {
  const dt = (date: string, time: string) => `${date.replace(/-/g, "")}T${time.replace(":", "")}00`;
  const end = event.endTime ?? event.startTime;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Plansphere//EN",
    "BEGIN:VEVENT",
    `UID:${event.id}@plansphere`,
    `SUMMARY:${event.title} — ${fest.name}`,
    `DTSTART:${dt(event.date, event.startTime)}`,
    `DTEND:${dt(event.date, end)}`,
    `LOCATION:${event.venue}`,
    `DESCRIPTION:${(event.description ?? "").replace(/\n/g, "\\n")}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join("\r\n"))}`;
};

/**
 * The registration side of the event page — 2a's right column on desktop and
 * its sticky footer on a phone. Owns the live seat count, the auth gating and
 * the sheet/dialog that holds the form.
 */
export const RegisterPanel = ({ event: initial, fest }: { event: Event; fest: Fest }) => {
  const { status, session, ready } = useAuth();
  const repos = useRepositories();
  const pathname = usePathname();
  const [event, setEvent] = React.useState(initial);
  const [open, setOpen] = React.useState(false);

  // Seats move while the student is reading; keep the count honest.
  React.useEffect(() => {
    return repos.events.subscribeById(initial.id, (next) => next && setEvent(next), () => undefined);
  }, [initial.id, repos]);

  const existing = useQuery({
    queryKey: ["registration-exists", session?.uid, event.id],
    enabled: status === "signed-in" && Boolean(session),
    queryFn: () => repos.registrations.existsForUserAndEvent(session!.uid, event.id),
  });

  const open_ = isRegistrationOpen(event);
  const left = seatsRemaining(event);
  const line = seatLine(event);
  const fillRatio = event.capacity > 0 ? event.registeredCount / event.capacity : 0;
  const isTeam = event.eventType === "team";
  const ctaLabel = isTeam ? "Register your team" : "Register";
  const entry = event.entryFee > 0 ? `₹${event.entryFee.toLocaleString("en-IN")}${event.paymentEnabled ? " · pay online" : ""}` : "Free entry";

  const signInHref = `/sign-in?next=${encodeURIComponent(pathname)}`;
  const verifyHref = `/verify-email?next=${encodeURIComponent(pathname)}`;

  const cta = (() => {
    if (!ready) return <Button variant="primary" size="lg" block disabled>{ctaLabel}</Button>;
    if (existing.data) {
      return (
        <Button asChild variant="secondary" size="lg" block>
          <Link href="/my-events">You’re registered · view ticket</Link>
        </Button>
      );
    }
    if (!open_) {
      return (
        <Button variant="secondary" size="lg" block disabled>
          {left === 0 ? (event.waitlistEnabled ? "Join waitlist" : "Event is full") : "Registration closed"}
        </Button>
      );
    }
    if (status === "signed-out") {
      return (
        <Button asChild variant="primary" size="lg" block>
          <Link href={signInHref}>Sign in to register</Link>
        </Button>
      );
    }
    if (session && !session.emailVerified) {
      return (
        <Button asChild variant="primary" size="lg" block>
          <Link href={verifyHref}>Verify your email to register</Link>
        </Button>
      );
    }
    return (
      <Button variant="primary" size="lg" block onClick={() => setOpen(true)}>
        {ctaLabel}
      </Button>
    );
  })();

  const formTitle = event.title;
  const formDescription = `${formatTeamSize(event.eventType, event.teamSize)} · one registration per person`;

  return (
    <>
      {/* Desktop column */}
      <div className="hidden flex-col gap-3.5 lg:flex">
        <div className="card elev-sm gap-3 p-[17px]">
          <div className="flex items-center justify-between">
            <span className="text-[20px] font-medium">{entry}</span>
            <Tag tone="outline">{line.text}</Tag>
          </div>
          {event.capacity > 0 ? (
            <div>
              <Bar value={fillRatio} />
              <div className="mt-1.5 text-[11.5px] text-neutral-500">
                {event.registeredCount} of {event.capacity} seats taken
              </div>
            </div>
          ) : null}
          <MetaList>
            <MetaRow label="When">
              {formatCalendarDate(event.date)} · {event.startTime}
              {event.endTime ? ` – ${event.endTime}` : ""}
            </MetaRow>
            <MetaRow label="Where">{event.venue}</MetaRow>
            {event.registrationDeadline ? <MetaRow label="Closes">{formatCalendarDate(event.registrationDeadline)}, 23:59</MetaRow> : null}
          </MetaList>
          {cta}
          <a href={icsHref(event, fest)} download={`${event.slug}.ics`} className="btn btn-secondary btn-block">
            <CalendarPlus size={15} /> Add to calendar
          </a>
        </div>
        <Note title={`Run by ${fest.organizationName}`}>
          Registrations, entry scans and certificates for this event are issued by the college’s own account. Your
          certificate is emailed to you and carries a link anyone can check against that record.
        </Note>
      </div>

      {/* Phone sticky footer */}
      <div className="fixed inset-x-0 bottom-[68px] z-30 border-t border-divider bg-bg px-[18px] pb-3.5 pt-3.5 lg:hidden">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="text-[13px] text-neutral-500">{entry} · fest pass required</span>
          <span className="text-[12px] text-accent-300">{line.text}</span>
        </div>
        {cta}
      </div>

      {/* Phone: bottom sheet */}
      <div className="lg:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent title={formTitle} description={formDescription}>
            <RegistrationForm event={event} fest={fest} onDone={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>

      {/* Desktop: dialog */}
      <div className="hidden lg:block">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent title={formTitle} description={formDescription} size="md">
            <RegistrationForm event={event} fest={fest} onDone={() => setOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>
    </>
  );
};
