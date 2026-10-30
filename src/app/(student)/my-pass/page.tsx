"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Page } from "@/components/shell/student-shell";
import { NotificationBell } from "@/components/shell/notifications";
import { DigitalTicket } from "@/components/student/digital-ticket";
import { bucketEntries, useMyEntries } from "@/components/student/use-my-entries";
import { EmptyState, Skeleton, StatusBanner, Tag } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Seg } from "@/components/ui/field";
import { formatCalendarDate } from "@/lib/utils";

/**
 * 2b — My pass. The next ticket, big, with a picker when there is more than
 * one. Reads from the local cache first, so it opens at the gate with no
 * signal.
 */
export default function MyPassPage() {
  const params = useSearchParams();
  const wanted = params.get("r");
  const { entries, isPending, online, fromCache } = useMyEntries();
  const { upcoming, attended } = bucketEntries(entries);

  const candidates = [...upcoming, ...attended];
  const [selectedId, setSelectedId] = React.useState<string | null>(wanted);
  const selected = candidates.find((e) => e.registration.id === (selectedId ?? candidates[0]?.registration.id)) ?? candidates[0];

  if (isPending && entries.length === 0) {
    return (
      <Page className="max-w-[560px] pt-2">
        <Skeleton className="mb-4 h-7 w-28" />
        <Skeleton className="h-[520px]" />
      </Page>
    );
  }

  if (!selected) {
    return (
      <Page className="max-w-[560px] pt-2">
        <div className="mb-3 flex items-center justify-between">
          <h4>My pass</h4>
          <NotificationBell className="sm:hidden" />
        </div>
        <EmptyState
          title="No tickets yet"
          body="Register for an event and its QR appears here, ready to show at the gate — even with no signal."
          action={
            <Button asChild variant="primary">
              <Link href="/explore">Browse fests</Link>
            </Button>
          }
        />
      </Page>
    );
  }

  return (
    <Page className="max-w-[560px] pb-8 pt-2">
      <div className="flex items-center justify-between">
        <h4>My pass</h4>
        <div className="flex items-center gap-1.5">
          <Tag tone="neutral">{online ? "Works offline" : "Offline · saved copy"}</Tag>
          <NotificationBell className="sm:hidden" />
        </div>
      </div>

      {!online && fromCache ? (
        <StatusBanner className="mt-3" tone="neutral">
          You’re offline. This is the last copy saved on this device.
        </StatusBanner>
      ) : null}

      {candidates.length > 1 ? (
        <div className="mt-3 max-w-full overflow-x-auto scrollbar-none">
          <Seg
            value={selected.registration.id}
            onChange={setSelectedId}
            options={candidates.map((e) => ({
              value: e.registration.id,
              label: e.event ? `${formatCalendarDate(e.event.date)} · ${e.registration.eventTitle}` : e.registration.eventTitle,
            }))}
            aria-label="Which ticket"
          />
        </div>
      ) : null}

      <div className="mt-3.5">
        <DigitalTicket
          registration={selected.registration}
          festName={selected.fest?.name ?? ""}
          organizationName={selected.fest?.organizationName}
          attendance={selected.attendance}
          meals={selected.meals}
          mealSlots={selected.event?.mealSlots ?? []}
        />
      </div>
    </Page>
  );
}
