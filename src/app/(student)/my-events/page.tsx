"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Page } from "@/components/shell/student-shell";
import { bucketEntries, useMyEntries, type Entry } from "@/components/student/use-my-entries";
import { useAuth, useRepositories } from "@/components/providers";
import { Seg } from "@/components/ui/field";
import { AlertDialog, AlertDialogContent, AlertDialogTrigger } from "@/components/ui/overlays";
import { AnimatedList, EmptyState, Kick, Skeleton, Tag } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { CERTIFICATE_LABELS } from "@/core/models/certificate";
import { formatCalendarDate } from "@/lib/utils";

type Bucket = "upcoming" | "attended" | "certificates";

const dayParts = (date?: string) => {
  if (!date) return { day: "—", mon: "" };
  const [, m, d] = date.split("-");
  const mon = new Intl.DateTimeFormat("en-GB", { month: "short" }).format(new Date(`${date}T00:00:00`)).toUpperCase();
  return { day: String(Number(d)), mon: mon || m || "" };
};

/**
 * 2b — My events. The segmented Upcoming · Attended · Certificates with the
 * date-block rows. Every state a ticket can be in maps to one tag: Checked in,
 * Ticket ready, Waitlisted · #n, Cancelled.
 */
export default function MyEventsPage() {
  const { entries, isPending, refetch } = useMyEntries();
  const { session } = useAuth();
  const repos = useRepositories();
  const [bucket, setBucket] = React.useState<Bucket>("upcoming");
  const { upcoming, attended } = bucketEntries(entries);

  const certificates = useQuery({
    queryKey: ["my-certificates", session?.uid],
    enabled: Boolean(session) && bucket === "certificates",
    queryFn: () => repos.certificates.listForUser(session!.uid),
  });

  const list = bucket === "upcoming" ? upcoming : attended;

  return (
    <Page className="max-w-[720px] pb-8 pt-2">
      <h4 className="mb-2.5">My events</h4>
      <Seg
        value={bucket}
        onChange={setBucket}
        options={[
          { value: "upcoming", label: `Upcoming${upcoming.length ? ` ${upcoming.length}` : ""}` },
          { value: "attended", label: `Attended${attended.length ? ` ${attended.length}` : ""}` },
          { value: "certificates", label: "Certificates" },
        ]}
        aria-label="Which events"
      />

      <div className="mt-2">
        {bucket === "certificates" ? (
          certificates.isPending ? (
            <Skeleton className="mt-3 h-24" />
          ) : certificates.data?.length ? (
            <AnimatedList stagger={35} maxDelay={280} variant="fade">
              {certificates.data.map((c) => (
                <div key={c.id} className="rule-b py-[13px]">
                  <div className="text-[13.5px] font-medium">
                    {c.eventTitle} — {CERTIFICATE_LABELS[c.type].replace("Certificate of ", "").toLowerCase()}
                  </div>
                  <div className="my-1 mb-2.5 text-[11.5px] text-neutral-500">
                    Issued {formatCalendarDate(c.issuedAt.toISOString().slice(0, 10))} · ID {c.certificateNumber} · publicly verifiable
                  </div>
                  <div className="flex gap-2">
                    {c.fileUrl ? (
                      <a href={c.fileUrl} className="btn btn-primary btn-sm" target="_blank" rel="noreferrer">
                        Download PDF
                      </a>
                    ) : (
                      <Button variant="primary" size="sm" disabled>
                        PDF on its way
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        await navigator.clipboard.writeText(`${window.location.origin}/verify/${c.certificateNumber}`);
                        toast.success("Verify link copied");
                      }}
                    >
                      Copy verify link
                    </Button>
                  </div>
                </div>
              ))}
            </AnimatedList>
          ) : (
            <EmptyState
              className="mt-3"
              title="No certificates yet"
              body="Certificates are issued after an event ends and your entry was scanned at the gate. Nothing to do on your side."
            />
          )
        ) : isPending && entries.length === 0 ? (
          <>
            <Skeleton className="mt-3 h-16" />
            <Skeleton className="mt-3 h-16" />
          </>
        ) : list.length === 0 ? (
          <EmptyState
            className="mt-3"
            title={bucket === "upcoming" ? "Nothing coming up" : "Nothing attended yet"}
            body={
              bucket === "upcoming"
                ? "Events you register for show up here with their ticket."
                : "Once your QR is scanned at a gate, the event moves here and its certificate follows."
            }
            action={
              bucket === "upcoming" ? (
                <Button asChild variant="primary">
                  <Link href="/explore">Browse fests</Link>
                </Button>
              ) : null
            }
          />
        ) : (
          <AnimatedList stagger={35} maxDelay={280} variant="fade">
            {list.map((entry) => <EntryRow key={entry.registration.id} entry={entry} onChanged={() => refetch()} />)}
          </AnimatedList>
        )}
      </div>

      {bucket === "upcoming" && attended.length === 0 && certificates.data?.length ? (
        <div className="pt-[18px]">
          <Kick className="mb-[9px]">Certificate ready</Kick>
        </div>
      ) : null}
    </Page>
  );
}

const EntryRow = ({ entry, onChanged }: { entry: Entry; onChanged: () => void }) => {
  const { registration, event, attendance } = entry;
  const repos = useRepositories();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const { day, mon } = dayParts(event?.date);

  const status = attendance ? (
    <Tag tone="accent" check>
      Checked in
    </Tag>
  ) : registration.status === "waitlisted" ? (
    <Tag tone="neutral">Waitlisted</Tag>
  ) : registration.status === "pending_payment" ? (
    <Tag tone="outline">Payment due</Tag>
  ) : registration.status === "draft" ? (
    <Tag tone="outline">Team incomplete</Tag>
  ) : registration.paymentStatus === "refund_pending" ? (
    <Tag tone="neutral">Refund pending</Tag>
  ) : registration.paymentStatus === "refunded" ? (
    <Tag tone="neutral">Refunded</Tag>
  ) : registration.status === "cancelled" ? (
    <Tag tone="neutral">Cancelled</Tag>
  ) : (
    <Tag tone="outline">Ticket ready</Tag>
  );

  const canCancel = !attendance && registration.status !== "cancelled" && event && event.status !== "ongoing" && event.status !== "completed";

  const cancel = async () => {
    setBusy(true);
    try {
      await repos.registrations.cancel(registration.id);
      toast.success("Registration cancelled");
      setOpen(false);
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't cancel");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rule-b flex gap-[11px] py-[13px]">
      <div className="w-11 flex-none text-center">
        <div className="text-[17px] font-medium">{day}</div>
        <div className="text-[10px] tracking-[0.06em] text-neutral-500">{mon}</div>
      </div>
      <div className="min-w-0 flex-1">
        <Link href={`/my-pass?r=${registration.id}`} className="text-[14.5px] font-medium text-inherit no-underline hover:text-accent">
          {registration.eventTitle}
        </Link>
        <div className="mt-[3px] text-[11.5px] text-neutral-500">
          {event ? `${event.startTime} · ${event.venue}` : "—"} · {registration.teamName ? `Team ${registration.teamName}` : "Solo"}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          {status}
          {canCancel ? (
            <AlertDialog open={open} onOpenChange={setOpen}>
              <AlertDialogTrigger asChild>
                <button type="button" className="btn btn-ghost btn-sm text-neutral-500">
                  Cancel
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent
                title="Cancel this registration?"
                description={
                  registration.paymentStatus === "paid"
                    ? `Your ${registration.teamName ? "team's " : ""}seat${registration.seats > 1 ? "s" : ""} for ${registration.eventTitle} will go back to the pool and a refund request goes to the organizers. This can't be undone.`
                    : `Your ${registration.teamName ? "team's " : ""}seat${registration.seats > 1 ? "s" : ""} for ${registration.eventTitle} will go back to the pool. This can't be undone.`
                }
                confirmLabel="Cancel registration"
                destructive
                loading={busy}
                onConfirm={cancel}
              />
            </AlertDialog>
          ) : null}
        </div>
      </div>
    </div>
  );
};
