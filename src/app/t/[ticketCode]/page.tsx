import { ADMISSION_MESSAGES, type AdmissionBlock } from "@/core/models/admission";
import type { Metadata } from "next";
import Link from "next/link";
import { Check, Warning } from "@phosphor-icons/react/dist/ssr";
import { PublicFooter, PublicNav } from "@/components/shell/public-nav";
import { Button } from "@/components/ui/button";
import { MetaList, MetaRow, Tag } from "@/components/ui/primitives";
import { lookupTicket, type PublicTicket } from "@/server/public-lookup";
import { isAdminConfigured } from "@/server/firebase-admin";
import { formatCalendarDate, formatClock } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ ticketCode: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { ticketCode } = await params;
  return { title: `Ticket ${ticketCode.toUpperCase()}`, robots: { index: false } };
}

/**
 * 4b — the two public QR validation outcomes. This is what any phone camera
 * lands on when it reads a pass; the gate scanner short-circuits the same
 * URL into its offline roster instead of loading this page.
 */
export default async function TicketPage({ params }: Params) {
  const { ticketCode } = await params;
  const fallback = { ticket: null, reason: "not-found" as const };
  const lookup = isAdminConfigured() ? await lookupTicket(ticketCode).catch(() => fallback) : fallback;
  const ticket = lookup.ticket;
  const valid = ticket && ticket.block === null;

  return (
    <div className="flex min-h-dvh flex-col">
      <PublicNav />
      <main id="main" className="mx-auto w-full max-w-[720px] flex-1 px-[18px] pb-16 pt-6 sm:px-6 sm:pt-10">
        {valid ? <Valid ticket={ticket} /> : <Invalid code={ticketCode.toUpperCase()} ticket={ticket} />}
      </main>
      <PublicFooter />
    </div>
  );
}

const shortDate = (iso: string | null) => (iso ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(iso)) : "—");

const Valid = ({ ticket }: { ticket: PublicTicket }) => (
  <div className="pl-5 shadow-[inset_3px_0_0_var(--color-accent)]">
    <div className="mb-3.5 flex flex-wrap items-center gap-[9px]">
      <Tag tone="accent" className="gap-[5px]">
        <Check size={12} weight="bold" aria-hidden />
        Valid ticket
      </Tag>
      <span className="text-[12.5px] text-neutral-500">
        Verified against the college’s record
      </span>
    </div>
    <div className="mb-1.5 text-[26px] font-medium leading-[1.1] tracking-[-0.025em] sm:text-[30px]">{ticket.holderName}</div>
    <div className="mb-5 text-[14px] text-neutral-300">
      {ticket.eventTitle} · {ticket.festSlug ? <Link href={`/f/${ticket.festSlug}`}>{ticket.festName}</Link> : ticket.festName}
      {ticket.issuer ? ` · ${ticket.issuer}` : ""}
    </div>
    <MetaList>
      <MetaRow label="Ticket" mono>
        {ticket.ticketCode}
      </MetaRow>
      <MetaRow label="Entry">
        {ticket.entryAt ? `${shortDate(ticket.entryAt)}, ${formatClock(new Date(ticket.entryAt))}${ticket.entryGate ? ` · ${ticket.entryGate}` : ""}` : "Not yet scanned"}
      </MetaRow>
      {ticket.eventDate ? (
        <MetaRow label="When">
          {formatCalendarDate(ticket.eventDate)}
          {ticket.eventStartTime ? `, ${ticket.eventStartTime}` : ""}
          {ticket.venue ? ` · ${ticket.venue}` : ""}
        </MetaRow>
      ) : null}
      {ticket.teamName ? (
        <MetaRow label="Team">
          {ticket.teamName} · {ticket.memberCount} member{ticket.memberCount === 1 ? "" : "s"}
        </MetaRow>
      ) : null}
    </MetaList>
    <div className="mt-5 max-w-[52ch] text-[12.5px] text-neutral-500">
      Only the gate scanner can mark this ticket as used. Opening this page does not admit anyone.
    </div>
  </div>
);

const INVALID_HEADING: Record<AdmissionBlock, string> = {
  cancelled: "Registration cancelled",
  waitlisted: "On the waitlist",
  draft: "Team not complete",
  unpaid: "Payment pending",
  refunded: "Registration cancelled",
};

const Invalid = ({ code, ticket }: { code: string; ticket: PublicTicket | null }) => (
  <div className="pl-5 shadow-[inset_3px_0_0_var(--color-neutral-600)]">
    <div className="mb-3.5 flex items-center gap-[9px]">
      <Tag tone="neutral" className="gap-[5px]">
        <Warning size={12} weight="bold" aria-hidden />
        Not a valid ticket
      </Tag>
    </div>
    <div className="mb-1.5 text-[26px] font-medium leading-[1.1] tracking-[-0.025em] sm:text-[30px]">{ticket ? INVALID_HEADING[ticket.block ?? "cancelled"] : "No record found"}</div>
    <p className="mb-5 max-w-[52ch] text-[14px] text-neutral-300">
      {ticket
        ? ticket.block === "cancelled" || ticket.block === null
          ? `This ticket for ${ticket.eventTitle} was cancelled and no longer admits anyone. The participant can register again if seats remain.`
          : `${ADMISSION_MESSAGES[ticket.block]} (${ticket.eventTitle})`
        : "This code doesn’t match any registration. It may have been cancelled, it may belong to a different fest, or the QR may have been altered."}
    </p>
    <MetaList>
      <MetaRow label="Code read" mono>
        {code}
      </MetaRow>
      <MetaRow label="What to do">Ask the participant to open My pass</MetaRow>
    </MetaList>
    <div className="mt-4 flex flex-wrap gap-[9px]">
      <Button asChild variant="secondary">
        <Link href="/sign-in?next=/my-pass">Open My pass</Link>
      </Button>
      <Button asChild variant="ghost">
        <Link href="/explore">Find the fest</Link>
      </Button>
    </div>
  </div>
);
