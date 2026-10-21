"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Check } from "@phosphor-icons/react";
import { Page } from "@/components/shell/student-shell";
import { DigitalTicket } from "@/components/student/digital-ticket";
import { PaymentPanel } from "@/components/student/payment-panel";
import { useMyEntries } from "@/components/student/use-my-entries";
import { useAuth } from "@/components/providers";
import { EmptyState, MetaList, MetaRow, Skeleton } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { formatCalendarDate } from "@/lib/utils";

/** 4b — "You're in". The confirmation, with the ticket already on screen. */
export default function RegisteredPage() {
  const { registrationId } = useParams<{ registrationId: string }>();
  const { session } = useAuth();
  const { entries, isPending } = useMyEntries();
  const entry = entries.find((e) => e.registration.id === registrationId);

  if (isPending && !entry) {
    return (
      <Page className="max-w-[560px] pt-7">
        <Skeleton className="mb-4 h-14 w-14 rounded-full" />
        <Skeleton className="mb-3 h-9 w-40" />
        <Skeleton className="mb-6 h-4 w-72" />
        <Skeleton className="h-[420px]" />
      </Page>
    );
  }

  if (!entry) {
    return (
      <Page className="max-w-[560px] pt-7">
        <EmptyState
          title="We couldn't find that registration"
          body="It may belong to a different account. Your entries are listed under My events."
          action={
            <Button asChild variant="primary">
              <Link href="/my-events">Go to My events</Link>
            </Button>
          }
        />
      </Page>
    );
  }

  const { registration, event, fest } = entry;
  const teammates = registration.members.filter((m) => !m.isLeader).map((m) => m.name.split(/\s+/)[0]);
  const waitlisted = registration.status === "waitlisted";
  const awaitingPayment = registration.status === "pending_payment";
  const refunding = registration.paymentStatus === "refund_pending" || registration.paymentStatus === "refunded";
  const draft = registration.status === "draft";
  const short = draft ? Math.max(0, (event?.teamSize.min ?? 1) - registration.members.filter((m) => m.isLeader || m.inviteStatus === "accepted").length) : 0;
  // A teammate opening the team pass sees the same ticket, with copy that
  // doesn't pretend they did the registering.
  const isLeader = !session || registration.userId === session.uid;
  const pending = registration.members.filter((m) => m.inviteStatus === "pending").length;

  return (
    <Page className="max-w-[560px] pb-10 pt-[26px]">
      <div className="mb-[18px] grid h-[58px] w-[58px] place-items-center rounded-full bg-accent-fill text-text">
        <Check size={28} weight="bold" />
      </div>
      <h1 className="text-[31px] leading-[1.06] tracking-[-0.025em]">
        {awaitingPayment
          ? "Complete your payment"
          : refunding
            ? "Entry cancelled"
            : waitlisted
          ? "You're on the list"
          : draft
            ? "Seats held for your team"
            : isLeader
              ? "You're in"
              : `You're on ${registration.teamName ?? "the team"}`}
      </h1>
      <p className="mt-2.5 text-[14px] text-neutral-300">
        {awaitingPayment ? (
          <>
            Your seat for {registration.eventTitle} is held while you pay. The ticket is issued once the payment is confirmed.
          </>
        ) : refunding ? (
          <>
            {registration.eventTitle} is cancelled for you. {registration.paymentStatus === "refunded" ? "Your payment has been refunded." : "Your refund is being processed."}
          </>
        ) : draft ? (
          <>
            Team {registration.teamName} has its seats for {registration.eventTitle}. It is confirmed once{" "}
            {short === 1 ? "one more person" : `${short} more people`} joins — until then the ticket is not valid for entry at any gate, and no QR is shown.
          </>
        ) : (
          <>
            {registration.teamName ? `Team ${registration.teamName} is` : "You're"} {waitlisted ? "waitlisted for" : "registered for"}{" "}
            {registration.eventTitle}.{!isLeader ? " One ticket admits the whole team." : ""}
          </>
        )}
      </p>

      {awaitingPayment && isLeader ? <PaymentPanel registration={registration} /> : null}

      {/* The moment the code is most useful: the leader has just registered
          and the people they need are standing next to them. */}
      {isLeader && !awaitingPayment && registration.joinCode && registration.type === "team" ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-md bg-surface px-3.5 py-3">
          <span className="text-[12px] text-neutral-500">Join code</span>
          <span className="font-mono text-[19px] tracking-[0.2em]">{registration.joinCode}</span>
          <span className="w-full text-[11.5px] text-neutral-500 sm:w-auto">
            Teammates enter it under Teams — no invitation needed.
          </span>
        </div>
      ) : null}

      <div className="mt-5">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="kick">Your ticket</span>
          {event ? (
            <span className="text-[13px]">
              {formatCalendarDate(event.date)} · {event.startTime} · {event.venue}
            </span>
          ) : null}
        </div>
        <DigitalTicket registration={registration} festName={fest?.name ?? ""} organizationName={fest?.organizationName} compact />
        <div className="mt-2 text-[12px] text-neutral-500">Saved to your device. Works with no signal.</div>
      </div>

      <MetaList className="mt-4">
        {isLeader && !awaitingPayment ? <MetaRow label="Confirmation email">Sent to {registration.userEmail}</MetaRow> : <MetaRow label="Team leader">{registration.userName}</MetaRow>}
        {teammates.length ? (
          <MetaRow label={isLeader ? "Teammates invited" : "Team"}>
            {teammates.join(", ")}
            {pending ? ` · ${pending} yet to accept` : ""}
          </MetaRow>
        ) : null}
        <MetaRow label="Certificate">After attendance is confirmed</MetaRow>
      </MetaList>

      <div className="mt-4 flex flex-col gap-[9px]">
        {awaitingPayment ? null : (
          <Button asChild variant="primary" size="lg" block>
            <Link href={`/my-pass?r=${registration.id}`}>View my pass</Link>
          </Button>
        )}
        {registration.type === "team" ? (
          <Button asChild variant="secondary" block>
            <Link href="/teams">{isLeader ? "Manage the team" : "View the team"}</Link>
          </Button>
        ) : null}
        <Button asChild variant="ghost" block>
          <Link href={fest ? `/f/${fest.slug}` : "/explore"}>Back to the fest</Link>
        </Button>
      </div>
    </Page>
  );
}
