"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CreditCard } from "@phosphor-icons/react";
import type { Registration } from "@/core/models/registration";
import { formatRupees } from "@/core/models/payment";
import { useRepositories } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { MetaList, MetaRow, StatusBanner } from "@/components/ui/primitives";

/** "12:04" — minutes and seconds left on the hold. */
const countdown = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * The payment step for a seat that is waiting to be paid for.
 *
 * Sends the person to the provider's hosted checkout. Coming back from it is
 * *not* proof of payment — on return, and on a button press, the server is
 * asked to check with the provider and tells us the truth. The seat is held
 * only for the time shown; after that it goes back to the pool.
 */
export const PaymentPanel = ({ registration }: { registration: Registration }) => {
  const repos = useRepositories();
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(() => Date.now());

  const expiresAt = registration.holdExpiresAt ? registration.holdExpiresAt.getTime() : null;
  const left = expiresAt === null ? null : expiresAt - now;
  const lapsed = left !== null && left <= 0;
  const failed = registration.paymentStatus === "failed";
  const review = registration.paymentStatus === "needs_review";

  React.useEffect(() => {
    if (expiresAt === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  const refresh = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["my-entries"] });
    router.refresh();
  }, [queryClient, router]);

  const check = React.useCallback(
    async (opts: { redirect: boolean }) => {
      setBusy(true);
      setMessage(null);
      try {
        const result = await repos.registrations.startPayment(registration.id);
        if (result.state === "paid") {
          toast.success("Payment received — you're in");
          await refresh();
          return;
        }
        if (opts.redirect) {
          // The server only returns addresses on the provider's own hosts; this is a second lock, not the first.
          if (result.redirectUrl && result.redirectUrl.startsWith("https://")) {
            window.location.assign(result.redirectUrl);
            return;
          }
          setMessage("This payment method can't be opened from here yet. Please contact the organizers.");
          return;
        }
        setMessage("We haven't received your payment yet. If you just paid, give it a minute — this page updates on its own.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Couldn't start the payment. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    [refresh, registration.id, repos],
  );

  // Back from the provider: ask the server what really happened.
  const returned = params.get("payment") === "return";
  const checked = React.useRef(false);
  React.useEffect(() => {
    if (!returned || checked.current || lapsed) return;
    checked.current = true;
    void check({ redirect: false });
  }, [returned, lapsed, check]);

  // While waiting on a payment that is in flight, pick up the confirmation when it lands.
  React.useEffect(() => {
    if (lapsed) return;
    const timer = window.setInterval(() => void queryClient.invalidateQueries({ queryKey: ["my-entries"] }), 8000);
    return () => window.clearInterval(timer);
  }, [lapsed, queryClient]);

  const amount = formatRupees(registration.amountPaise ?? 0);

  if (review) {
    return (
      <StatusBanner className="mt-4" tone="neutral">
        We received a payment for this seat that doesn’t match the amount due, so it’s with the organizers for review. Your seat is held and nothing more is charged.
      </StatusBanner>
    );
  }

  if (lapsed) {
    return (
      <StatusBanner className="mt-4" tone="neutral">
        The hold on your seat has run out. If you already paid, it will be confirmed or refunded automatically; otherwise register again to get a new hold.
      </StatusBanner>
    );
  }

  return (
    <div className="mt-4 rounded-md bg-surface p-3.5">
      <MetaList>
        <MetaRow label="Amount due">{amount}</MetaRow>
        {left !== null ? <MetaRow label="Seat held for">{countdown(left)}</MetaRow> : null}
        <MetaRow label="Fees">None added — you pay the entry fee only</MetaRow>
      </MetaList>
      {failed ? <p className="mt-2.5 text-[12.5px] text-neutral-300">That payment didn’t go through. You can try again while your seat is held.</p> : null}
      {message ? <p className="mt-2.5 text-[12.5px] text-neutral-300">{message}</p> : null}
      <Button variant="primary" size="lg" block className="mt-3" disabled={busy} onClick={() => void check({ redirect: true })}>
        <CreditCard size={17} /> {busy ? "One moment…" : failed ? `Try again · ${amount}` : `Pay ${amount}`}
      </Button>
      <p className="mt-2 text-[11.5px] text-neutral-500">
        Your ticket is issued once the payment is confirmed. Cancelling before you pay releases the seat and charges nothing.
      </p>
    </div>
  );
};
