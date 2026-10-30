"use client";

import { isAdmissible } from "@/core/models/admission";
import * as React from "react";
import Link from "next/link";
import QRCode from "react-qr-code";
import { useQuery } from "@tanstack/react-query";
import { Page } from "@/components/shell/student-shell";
import { useMyEntries, type Entry } from "@/components/student/use-my-entries";
import { useAuth, useRepositories } from "@/components/providers";
import { Seg } from "@/components/ui/field";
import { AnimatedList, EmptyState, MetaList, MetaRow, Skeleton, Tag } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { acceptedCount } from "@/core/models/registration";
import { formatCalendarDate } from "@/lib/utils";
import { ticketUrl } from "@/components/student/digital-ticket";

/**
 * My registrations — every entry the student holds, by state.
 *
 * Distinct from My events, which is about what is happening next. This page
 * answers the other question: "where does each of my entries stand?" —
 * including the ones that went nowhere, because a cancelled entry and a
 * waitlisted one both need somewhere to be seen.
 */

type Bucket = "upcoming" | "completed" | "waitlisted" | "cancelled";

const LABELS: Record<Bucket, string> = {
  upcoming: "Upcoming",
  completed: "Completed",
  waitlisted: "Waitlisted",
  cancelled: "Cancelled",
};

/**
 * Which bucket an entry belongs in.
 *
 * State first, then time: a waitlisted entry for a past event is still
 * waitlisted — it never became anything — and a cancelled one never moves.
 */
const bucketFor = (entry: Entry, today: string): Bucket => {
  const status = entry.registration.status;
  if (status === "cancelled") return "cancelled";
  if (status === "waitlisted") return "waitlisted";
  if (entry.attendance) return "completed";
  if (entry.event && entry.event.date < today) return "completed";
  return "upcoming";
};

export default function MyRegistrationsPage() {
  const { entries, isPending } = useMyEntries();
  const { session } = useAuth();
  const repos = useRepositories();
  const [bucket, setBucket] = React.useState<Bucket>("upcoming");

  const today = new Date().toISOString().slice(0, 10);

  // Invitations the student has not answered live under Teams; showing them
  // here as registrations would be claiming something they have not agreed to.
  const mine = entries.filter((entry) => !entry.invited);

  const byBucket = React.useMemo(() => {
    const out: Record<Bucket, Entry[]> = { upcoming: [], completed: [], waitlisted: [], cancelled: [] };
    for (const entry of mine) out[bucketFor(entry, today)].push(entry);
    const byDate = (a: Entry, b: Entry) => (a.event?.date ?? "").localeCompare(b.event?.date ?? "");
    out.upcoming.sort(byDate);
    out.waitlisted.sort(byDate);
    out.completed.sort((a, b) => -byDate(a, b));
    out.cancelled.sort((a, b) => -byDate(a, b));
    return out;
  }, [mine, today]);

  // Certificates are joined in so each card can say whether one is waiting,
  // rather than sending the student to another page to find out.
  const certificates = useQuery({
    queryKey: ["my-certificates", session?.uid],
    enabled: Boolean(session),
    queryFn: () => repos.certificates.listForUser(session!.uid),
    staleTime: 60_000,
  });

  const certificateByEvent = React.useMemo(
    () => new Map((certificates.data ?? []).map((certificate) => [certificate.eventId, certificate])),
    [certificates.data],
  );

  const list = byBucket[bucket];

  if (isPending && entries.length === 0) {
    return (
      <Page className="max-w-[720px] pb-8 pt-2">
        <Skeleton className="mb-3 h-7 w-44" />
        <Skeleton className="h-64" />
      </Page>
    );
  }

  return (
    <Page className="max-w-[720px] pb-8 pt-2">
      <h4 className="mb-2.5">My registrations</h4>

      <div className="max-w-full overflow-x-auto scrollbar-none">
        <Seg
          value={bucket}
          onChange={setBucket}
          options={(Object.keys(LABELS) as Bucket[]).map((key) => ({
            value: key,
            label: `${LABELS[key]}${byBucket[key].length ? ` ${byBucket[key].length}` : ""}`,
          }))}
          aria-label="Which registrations"
        />
      </div>

      <div className="mt-3.5 flex flex-col gap-3">
        {list.length === 0 ? (
          <EmptyState
            title={
              bucket === "upcoming"
                ? "Nothing coming up"
                : bucket === "completed"
                  ? "Nothing completed yet"
                  : bucket === "waitlisted"
                    ? "You're not on any waitlist"
                    : "Nothing cancelled"
            }
            body={
              bucket === "upcoming"
                ? "Everything open to register is on Explore — one pass covers the whole fest."
                : bucket === "completed"
                  ? "Events you attend appear here afterwards, with the certificate once it is released."
                  : bucket === "waitlisted"
                    ? "When an event is full you can still join its waitlist; if a seat frees up you are promoted automatically."
                    : "Entries you cancel are kept here so the record stays honest."
            }
            action={
              bucket === "upcoming" ? (
                <Button asChild variant="primary">
                  <Link href="/explore">Browse fests</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <AnimatedList stagger={45} maxDelay={320} className="flex flex-col gap-3">
            {list.map((entry) => (
              <RegistrationCard key={entry.registration.id} entry={entry} certificate={certificateByEvent.get(entry.registration.eventId)} />
            ))}
          </AnimatedList>
        )}
      </div>
    </Page>
  );
}

const RegistrationCard = ({
  entry,
  certificate,
}: {
  entry: Entry;
  certificate?: { id: string; certificateNumber: string; fileUrl?: string | undefined };
}) => {
  const { registration, event, fest, attendance } = entry;
  const isTeam = registration.type === "team";
  const accepted = acceptedCount(registration.members);
  const minimum = event?.teamSize.min ?? 1;
  const short = isTeam ? Math.max(0, minimum - accepted) : 0;

  const live = isAdmissible(registration);

  return (
    <article className="panel p-3.5">
      <div className="flex gap-3.5">
        {live ? (
          <div className="flex-none">
            {/* Small on purpose: this is a reminder that the pass exists, not
                the pass itself — that is one tap away and full-width. */}
            <Link href={`/my-pass?r=${registration.id}`} aria-label="Open the full pass">
              <div className="rounded-md bg-white p-1.5">
                <QRCode value={ticketUrl(registration.ticketCode)} size={72} style={{ width: 72, height: 72 }} level="M" />
              </div>
            </Link>
          </div>
        ) : null}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-[15px] font-medium">{registration.eventTitle}</h3>
              <div className="truncate text-[12px] text-neutral-500">
                {fest?.name ?? ""}
                {event ? ` · ${formatCalendarDate(event.date)}` : ""}
                {event?.startTime ? ` · ${event.startTime}` : ""}
              </div>
            </div>
            <StatusTag entry={entry} />
          </div>

          <MetaList className="mt-2.5">
            {event?.venue ? <MetaRow label="Venue">{event.venue}</MetaRow> : null}
            <MetaRow label="Ticket" mono>
              {registration.ticketCode}
            </MetaRow>
            {isTeam ? (
              <MetaRow label="Team">
                {registration.teamName ?? "Unnamed"} · {accepted} of {registration.members.length} confirmed
                {short > 0 ? ` · ${short} more needed` : ""}
              </MetaRow>
            ) : null}
            {registration.joinCode && short > 0 ? (
              <MetaRow label="Join code" mono>
                {registration.joinCode}
              </MetaRow>
            ) : null}
            {attendance ? <MetaRow label="Checked in">{attendance.scannedAt.toLocaleString("en-GB")}</MetaRow> : null}
          </MetaList>

          <div className="mt-3 flex flex-wrap gap-2">
            {live ? (
              <Button asChild variant="secondary" size="sm">
                <Link href={`/my-pass?r=${registration.id}`}>Show pass</Link>
              </Button>
            ) : null}
            <Button asChild variant="ghost" size="sm">
              <Link href={`/registered/${registration.id}`}>Details</Link>
            </Button>
            {isTeam ? (
              <Button asChild variant="ghost" size="sm">
                <Link href="/teams">Manage team</Link>
              </Button>
            ) : null}
            {certificate ? (
              certificate.fileUrl ? (
                <a href={certificate.fileUrl} className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer">
                  Certificate
                </a>
              ) : (
                <Button asChild variant="ghost" size="sm">
                  <Link href="/certificates">Certificate</Link>
                </Button>
              )
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
};

/** One tag per state, phrased as the answer to "where does this stand?". */
const StatusTag = ({ entry }: { entry: Entry }) => {
  const { registration, attendance, event } = entry;

  if (registration.paymentStatus === "refund_pending") return <Tag tone="neutral">Refund pending</Tag>;
  if (registration.paymentStatus === "refunded") return <Tag tone="neutral">Refunded</Tag>;
  if (registration.status === "cancelled") return <Tag tone="neutral">Cancelled</Tag>;
  if (registration.status === "pending_payment") return <Tag tone="outline">Payment due</Tag>;
  if (registration.status === "waitlisted") return <Tag tone="outline">Waitlisted</Tag>;
  if (attendance) return <Tag tone="accent">Checked in</Tag>;
  if (registration.status === "draft") {
    const short = Math.max(0, (event?.teamSize.min ?? 1) - acceptedCount(registration.members));
    return <Tag tone="outline">{short > 0 ? `${short} more to confirm` : "Team incomplete"}</Tag>;
  }
  return <Tag tone="accent">Ticket ready</Tag>;
};
