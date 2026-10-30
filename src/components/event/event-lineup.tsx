"use client";

import * as React from "react";
import Link from "next/link";
import type { Event } from "@/core/models/event";
import { categoryLabel } from "@/core/models/event";
import { Seg } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/primitives";
import { useAuth } from "@/components/providers";
import { EventCard } from "./event-card";

type Filter = "all" | string;

/**
 * The fest page's event grid with the category segmented control (1a web),
 * and the "Closing soon" rail on a phone. Server-loaded events, client filter.
 */
export const EventLineup = ({ events, festSlug }: { events: Event[]; festSlug: string }) => {
  // Whatever categories the fest actually used, in the order they first
  // appear — a custom category is a segment exactly like a built-in one.
  const categories = React.useMemo(() => [...new Set(events.map((e) => e.category))], [events]);

  const [filter, setFilter] = React.useState<Filter>("all");

  const visible = filter === "all" ? events : events.filter((e) => e.category === filter);

  const closingSoon = React.useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return [...events]
      .filter((e) => e.registrationOpen && e.status !== "completed" && e.status !== "cancelled")
      .sort((a, b) => (a.registrationDeadline ?? a.date).localeCompare(b.registrationDeadline ?? b.date))
      .filter((e) => (e.registrationDeadline ?? e.date) >= today)
      .slice(0, 8);
  }, [events]);

  if (events.length === 0) {
    return (
      <EmptyState
        title="The lineup isn't published yet"
        body="The college is still adding events. Save the fest and you'll see them here the moment they go live."
      />
    );
  }

  return (
    <>
      {/* Phone: rail */}
      <div className="sm:hidden">
        <div className="mb-[11px] flex items-center justify-between pr-[18px]">
          <div className="text-[14.5px] font-medium">Closing soon</div>
          <Link href="#lineup" className="btn btn-ghost text-[12px]">
            See all {events.length}
          </Link>
        </div>
        <div className="flex gap-[11px] overflow-x-auto pr-[18px] scrollbar-none">
          {(closingSoon.length ? closingSoon : events.slice(0, 8)).map((event) => (
            <EventCard key={event.id} event={event} festSlug={festSlug} variant="rail" />
          ))}
        </div>
      </div>

      {/* Everyone: the full lineup */}
      <div id="lineup" className="mt-8 scroll-mt-6 border-t border-divider pt-8 sm:mt-0">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <span className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-600">
              [ lineup ]
            </span>
            <h2 className="text-[22px] tracking-[-0.02em] sm:text-[26px]">{filter === "all" ? "The lineup" : categoryLabel(filter)}</h2>
          </div>
          {categories.length > 1 ? (
            <div className="max-w-full overflow-x-auto scrollbar-none">
              <Seg
                value={filter}
                onChange={setFilter}
                options={[{ value: "all" as Filter, label: "All" }, ...categories.map((c) => ({ value: c, label: categoryLabel(c) }))]}
                aria-label="Category"
              />
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-x-[18px] gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
          {visible.map((event) => (
            <div key={event.id} className="transition-transform duration-200 hover:-translate-y-1">
              <EventCard event={event} festSlug={festSlug} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

/**
 * "Get your pass" — the marquee's filled CTA. Signed out it starts sign-up;
 * signed in it takes you to the lineup, since the pass is the account itself.
 */
export const PassCta = ({ festSlug, eventCount }: { festSlug: string; eventCount: number }) => {
  const { status } = useAuth();
  const target = status === "signed-in" ? "#lineup" : `/create-account?next=${encodeURIComponent(`/f/${festSlug}`)}`;

  return (
    <div className="flex flex-wrap gap-2.5">
      <Link href={target} className="btn btn-fill btn-lg">
        {status === "signed-in" ? "Browse the lineup" : "Get your pass"}
      </Link>
      <Link href="#lineup" className="btn btn-secondary btn-lg">
        Browse {eventCount} events
      </Link>
    </div>
  );
};
