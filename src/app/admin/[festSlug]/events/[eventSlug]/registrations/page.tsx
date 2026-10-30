"use client";

import * as React from "react";
import { AdminPage } from "@/components/shell/admin-shell";
import { useAdminEvent } from "@/components/admin/event-context";
import { useEventAttendance, useFestRegistrations } from "@/components/admin/hooks";
import { RegistrationsTable } from "@/components/admin/registrations-table";
import { PageHeading } from "@/components/ui/primitives";

/** 3b scoped to one event — "Codeflow 12hr Hackathon · 103 of 120 seats · 34 teams". */
export default function EventRegistrationsPage() {
  const { event } = useAdminEvent();
  const registrations = useFestRegistrations(event.festId, event.id);
  const att = useEventAttendance(event.id);

  const attendance = React.useMemo(() => new Map((att.data ?? []).map((a) => [a.registrationId, a])), [att.data]);
  const confirmed = (registrations.data ?? []).filter((r) => r.status === "confirmed");
  const teams = confirmed.filter((r) => r.type === "team").length;

  return (
    <AdminPage className="pb-9 pt-[26px]">
      <PageHeading
        title="Registrations"
        sub={`${event.title} · ${event.registeredCount}${event.capacity > 0 ? ` of ${event.capacity}` : ""} seats${teams ? ` · ${teams} teams` : ""}`}
        className="mb-[18px]"
      />
      <RegistrationsTable
        registrations={registrations.data}
        attendance={attendance}
        events={[event]}
        event={event}
        loading={registrations.loading}
      />
    </AdminPage>
  );
}
