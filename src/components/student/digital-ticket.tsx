"use client";

import * as React from "react";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import { DownloadSimple, Printer, Wallet } from "@phosphor-icons/react";
import type { Registration } from "@/core/models/registration";
import type { Attendance, FoodCollection } from "@/core/models/attendance";
import { Kick, Reveal, Tag } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { formatClock } from "@/lib/utils";
import { WALLET_SUPPORT } from "@/core/services/wallet";
import { admissionBlock } from "@/core/models/admission";

/**
 * The digital ticket — 2b.
 *
 * The QR encodes the public validation URL (`/t/PS-…`), so a random phone
 * camera opens a page that says whether the ticket is real, while the gate
 * scanner reads the code out of the same URL. The card is rendered from local
 * data whenever possible: "Works offline" is a promise the page keeps by
 * caching the student's entries in localStorage (see `useOfflineTickets`).
 */

export const ticketUrl = (ticketCode: string): string =>
  `${process.env.NEXT_PUBLIC_APP_URL ?? (typeof window !== "undefined" ? window.location.origin : "")}/t/${ticketCode}`;

export interface DigitalTicketProps {
  registration: Registration;
  festName: string;
  organizationName?: string;
  attendance?: Attendance | null;
  meals?: FoodCollection[];
  /** Meal slots the event defines, so unserved ones show as neutral tags. */
  mealSlots?: Array<{ date: string; mealType: string; label: string }>;
  compact?: boolean;
}

export const DigitalTicket = ({
  registration,
  festName,
  organizationName,
  attendance,
  meals = [],
  mealSlots = [],
  compact,
}: DigitalTicketProps) => {
  const qrRef = React.useRef<HTMLDivElement>(null);
  const served = new Set(meals.map((m) => `${m.servedOn}_${m.mealType}`));
  // A paid entry has no usable ticket until its payment is verified: no QR, nothing to screenshot.
  // (A waitlisted entry keeps its code — it activates if a seat opens — but the gate will say so.)
  const block = admissionBlock(registration);
  // A draft team's ticket is not an entry yet either, so it shows no QR until the team is complete.
  const valid = block !== "unpaid" && block !== "refunded" && block !== "draft";

  const download = async () => {
    const svg = qrRef.current?.querySelector("svg");
    if (!svg) return;
    try {
      const xml = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([xml], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("render"));
        img.src = url;
      });
      const size = 1024;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size + 160;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 64, 48, size - 128, size - 128);
      ctx.fillStyle = "#101010";
      ctx.font = "600 44px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.fillText(registration.ticketCode, size / 2, size + 40);
      ctx.font = "400 28px system-ui, sans-serif";
      ctx.fillStyle = "#666663";
      ctx.fillText(`${registration.eventTitle} · ${festName}`, size / 2, size + 100);
      URL.revokeObjectURL(url);
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `plansphere-${registration.ticketCode}.png`;
      a.click();
    } catch {
      toast.error("Couldn't render the image. Screenshot the QR instead.");
    }
  };

  return (
    <Reveal className="ticket-print overflow-hidden rounded-lg shadow-md">
      <div className="px-[18px] pb-3.5 pt-4">
        <Kick className="mb-[5px]">
          {festName}
          {organizationName ? ` · ${organizationName}` : ""}
        </Kick>
        <div className="text-[20px] font-medium tracking-[-0.015em]">{registration.eventTitle}</div>
        <div className="mt-1 text-[12.5px] text-neutral-500">
          {registration.teamName
            ? `Team ${registration.teamName} · ${registration.members.length} members`
            : registration.userName}
          {registration.status === "waitlisted" ? " · waitlisted" : null}
        </div>
      </div>

      <div className="px-[18px] pb-4">
        {valid ? (
          <>
            <div ref={qrRef} className={`mx-auto rounded-md bg-white p-3 ${compact ? "max-w-[200px]" : "max-w-[280px]"}`}>
              <QRCode value={ticketUrl(registration.ticketCode)} size={256} style={{ width: "100%", height: "auto" }} level="M" />
            </div>
            <div className="code mt-[11px] text-center text-[13px] tracking-[0.14em]">{registration.ticketCode}</div>
            <div className="mt-[3px] text-center text-[11.5px] text-neutral-500">
              {registration.status === "waitlisted"
                ? "Waitlisted — not valid for entry unless a seat opens and this entry is confirmed."
                : "Show this at the gate. No network needed."}
            </div>
          </>
        ) : (
          <div className={`mx-auto grid place-items-center rounded-md bg-surface p-6 text-center ${compact ? "max-w-[200px]" : "max-w-[280px]"}`}>
            <div className="text-[13.5px] font-medium">{block === "draft" ? "Team not complete yet" : block === "refunded" ? "Ticket withdrawn" : "Ticket not issued yet"}</div>
            <div className="mt-1 text-[12px] text-neutral-500">
              {block === "draft"
                ? "Your seats are held, but this ticket isn’t valid for entry until enough teammates have joined. The QR appears here the moment your team is complete."
                : block === "refunded"
                  ? "This entry was cancelled and the payment is being returned."
                  : "The QR appears here as soon as your payment is confirmed."}
            </div>
          </div>
        )}
      </div>

      {attendance || mealSlots.length ? (
        <div className="border-t border-divider px-[18px] pb-4 pt-3">
          <Kick className="mb-2">Entry & meals</Kick>
          <div className="flex flex-wrap gap-1.5">
            {attendance ? (
              <Tag tone="accent" check>
                Entry {formatClock(attendance.scannedAt)}
              </Tag>
            ) : (
              <Tag tone="neutral">Not checked in</Tag>
            )}
            {mealSlots.map((slot) => {
              const done = served.has(`${slot.date}_${slot.mealType}`);
              return (
                <Tag key={`${slot.date}_${slot.mealType}`} tone={done ? "accent" : "neutral"} check={done}>
                  {slot.label}
                </Tag>
              );
            })}
          </div>
        </div>
      ) : null}

      {!compact && valid ? (
        <div className="ticket-actions border-t border-divider px-[18px] py-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" className="flex-1" onClick={download}>
              <DownloadSimple size={15} /> Download PNG
            </Button>
            <Button variant="secondary" className="flex-1" onClick={() => window.print()}>
              <Printer size={15} /> Print
            </Button>
          </div>

          {/*
            Wallet passes need credentials the college has to obtain — an
            Apple Pass Type ID certificate, a Google issuer key — so the
            buttons state that rather than pretending. Everything behind them
            is built: see core/services/wallet.ts and the route it names.
          */}
          <div className="mt-2 flex flex-wrap gap-2">
            {(["apple", "google"] as const).map((platform) => (
              <Button
                key={platform}
                variant="ghost"
                size="sm"
                className="flex-1"
                disabled
                title={WALLET_SUPPORT[platform].requires}
              >
                <Wallet size={15} /> {platform === "apple" ? "Apple Wallet" : "Google Wallet"}
              </Button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-neutral-500">
            Wallet passes are not enabled on this deployment. The pass above already works with no network, and prints.
          </p>
        </div>
      ) : null}
    </Reveal>
  );
};
