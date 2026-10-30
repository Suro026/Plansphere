"use client";

import * as React from "react";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { useFestEvents, useFestGateFeed, useFestRegistrations } from "@/components/admin/hooks";
import { RegistrationsTable } from "@/components/admin/registrations-table";
import { PageHeading } from "@/components/ui/primitives";

/** 3b — every registration in the fest, live. */
export default function FestRegistrationsPage() {
  const { fest } = useFest();
  const events = useFestEvents(fest.id);
  const registrations = useFestRegistrations(fest.id);
  const feed = useFestGateFeed(fest.id, 10000);

  const attendance = React.useMemo(() => new Map((feed.data ?? []).map((a) => [a.registrationId, a])), [feed.data]);
  // This page is driven by a live registrations listener, which can push an
  // update every few seconds during a registration rush — worth not re-
  // filtering/re-reducing the whole list on renders it didn't cause too.
  const { seats, teams } = React.useMemo(() => {
    const confirmed = (registrations.data ?? []).filter((r) => r.status === "confirmed");
    return { seats: confirmed.reduce((s, r) => s + r.seats, 0), teams: confirmed.filter((r) => r.type === "team").length };
  }, [registrations.data]);

  return (
    <AdminPage className="pb-9 pt-[26px]">
      <PageHeading
        title="Registrations"
        sub={`${fest.name} · ${seats.toLocaleString("en-IN")} seats taken${teams ? ` · ${teams} teams` : ""}`}
        className="mb-[18px]"
      />
      <RegistrationsTable
        registrations={registrations.data}
        attendance={attendance}
        events={events.data ?? []}
        loading={registrations.loading || events.loading}
      />
    </AdminPage>
  );
}
