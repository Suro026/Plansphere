"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { useFestEvents } from "@/components/admin/hooks";
import { useRepositories } from "@/components/providers";
import { RepositoryError } from "@/core/models/common";
import { Seg, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Bar, EmptyState, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import type { Event, EventStatus } from "@/core/models/event";
import { categoryLabel } from "@/core/models/event";
import { formatCalendarDate, formatTeamSize } from "@/lib/utils";

type Filter = "all" | "live" | "published" | "draft" | "completed" | "archived";

const matches = (event: Event, filter: Filter): boolean => {
  const archived = event.visibility === "archived";
  if (filter === "archived") return archived;
  if (archived) return false; // an archived event only shows up under its own tab
  switch (filter) {
    case "live":
      return event.status === "ongoing";
    case "published":
      return event.status === "published";
    case "draft":
      return event.status === "draft";
    case "completed":
      return event.status === "completed" || event.status === "cancelled";
    default:
      return true;
  }
};

const STATUS_TAG: Record<EventStatus, { tone: "accent" | "neutral" | "outline"; label: string }> = {
  draft: { tone: "outline", label: "Draft" },
  published: { tone: "neutral", label: "Published" },
  ongoing: { tone: "accent", label: "Ongoing" },
  completed: { tone: "neutral", label: "Completed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

/**
 * Events — the list the canvas implies but never draws (its console shows a
 * three-row excerpt). Same table vocabulary as Overview, plus the per-event
 * actions the other admin screens hang off.
 */
export default function EventsPage() {
  const { fest, basePath } = useFest();
  const events = useFestEvents(fest.id);
  const repos = useRepositories();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [search, setSearch] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);

  const duplicate = async (event: Event) => {
    setBusy(event.id);
    try {
      const copy = await repos.events.duplicate(event.id);
      toast.success(`Duplicated as "${copy.title}"`);
    } catch (error) {
      toast.error(error instanceof RepositoryError ? error.message : "Couldn't duplicate");
    } finally {
      setBusy(null);
    }
  };

  const all = events.data ?? [];
  const term = search.trim().toLowerCase();
  const visible = all.filter((e) => matches(e, filter) && (!term || e.title.toLowerCase().includes(term) || e.venue.toLowerCase().includes(term)));

  const active = all.filter((e) => e.visibility !== "archived");
  const counts = {
    all: active.length,
    live: active.filter((e) => e.status === "ongoing").length,
    published: active.filter((e) => e.status === "published").length,
    draft: active.filter((e) => e.status === "draft").length,
    completed: active.filter((e) => e.status === "completed" || e.status === "cancelled").length,
    archived: all.filter((e) => e.visibility === "archived").length,
  };

  return (
    <AdminPage className="pb-9 pt-[26px]">
      <PageHeading
        title="Events"
        sub={`${all.length} in ${fest.name} · ${all.reduce((s, e) => s + e.registeredCount, 0).toLocaleString("en-IN")} seats taken`}
        actions={
          <Button asChild variant="primary">
            <Link href={`${basePath}/events/new`}>Create event</Link>
          </Button>
        }
        className="mb-[18px]"
      />

      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-full overflow-x-auto scrollbar-none">
          <Seg
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: `All ${counts.all}` },
              { value: "live", label: `Live ${counts.live}` },
              { value: "published", label: `Published ${counts.published}` },
              { value: "draft", label: `Drafts ${counts.draft}` },
              { value: "completed", label: `Ended ${counts.completed}` },
              ...(counts.archived > 0 ? [{ value: "archived" as Filter, label: `Archived ${counts.archived}` }] : []),
            ]}
            aria-label="Filter events"
          />
        </div>
        <Input type="search" placeholder="Search title or venue" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full sm:w-[220px]" aria-label="Search events" />
      </div>

      {events.loading ? (
        <Skeleton className="h-64" />
      ) : visible.length === 0 ? (
        <EmptyState
          title={all.length === 0 ? "No events yet" : "Nothing matches"}
          body={all.length === 0 ? "Create your first event — three steps and a live preview of what students will see." : "Try another filter or clear the search."}
          action={
            all.length === 0 ? (
              <Button asChild variant="primary">
                <Link href={`${basePath}/events/new`}>Create an event</Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Date</th>
                <th>Type</th>
                <th>Capacity</th>
                <th>Registered</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((event) => {
                const tag = STATUS_TAG[event.status];
                const href = `${basePath}/events/${event.slug}`;
                return (
                  <tr key={event.id}>
                    <td>
                      <Link href={`${href}/settings`} className="text-inherit no-underline hover:text-accent">
                        {event.title}
                      </Link>
                      <div className="text-[11.5px] text-neutral-500">
                        {categoryLabel(event.category)} · {event.venue}
                      </div>
                    </td>
                    <td className="whitespace-nowrap">
                      {formatCalendarDate(event.date)} · {event.startTime}
                    </td>
                    <td className="whitespace-nowrap">{formatTeamSize(event.eventType, event.teamSize)}</td>
                    <td className="w-[110px]">
                      {event.capacity > 0 ? <Bar value={event.registeredCount / event.capacity} /> : <span className="text-neutral-500">∞</span>}
                    </td>
                    <td className="whitespace-nowrap">
                      {event.registeredCount}
                      {event.capacity > 0 ? ` / ${event.capacity}` : ""}
                    </td>
                    <td>
                      <Tag tone={tag.tone}>{tag.label}</Tag>
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <Link href={`${href}/registrations`} className="btn btn-ghost text-[12px]">
                        Registrations
                      </Link>
                      <Link href={`${href}/analytics`} className="btn btn-ghost text-[12px]">
                        Analytics
                      </Link>
                      <Link href={`${href}/settings`} className="btn btn-ghost text-[12px]">
                        Settings
                      </Link>
                      <button type="button" className="btn btn-ghost text-[12px]" disabled={busy === event.id} onClick={() => duplicate(event)}>
                        Duplicate
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AdminPage>
  );
}
