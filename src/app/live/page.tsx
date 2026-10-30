"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useRepositories } from "@/components/providers";
import { useLiveMatches } from "@/components/live/hooks";
import { PublicFooter, PublicNav } from "@/components/shell/public-nav";
import { EmptyState, Kick, Panel, Skeleton, Tag } from "@/components/ui/primitives";

/**
 * 11 — the public live directory: every match currently live, anywhere on
 * the platform, with no account needed. One card per match, since a match
 * is what actually has an arena and a score; tapping it opens the event's
 * full live page.
 */
export default function LiveDirectoryPage() {
  const repos = useRepositories();
  const live = useLiveMatches();

  const eventIds = React.useMemo(() => [...new Set((live.data ?? []).map((m) => m.eventId))].sort(), [live.data]);
  const festIds = React.useMemo(() => [...new Set((live.data ?? []).map((m) => m.festId))].sort(), [live.data]);

  const events = useQuery({
    queryKey: ["live-directory-events", eventIds],
    enabled: eventIds.length > 0,
    queryFn: () => repos.events.getManyByIds(eventIds),
  });
  const fests = useQuery({
    queryKey: ["live-directory-fests", festIds],
    enabled: festIds.length > 0,
    queryFn: () => Promise.all(festIds.map((id) => repos.fests.getById(id))),
  });

  const eventById = React.useMemo(() => new Map((events.data ?? []).map((e) => [e.id, e])), [events.data]);
  const festById = React.useMemo(() => new Map((fests.data ?? []).filter((f) => f).map((f) => [f!.id, f!])), [fests.data]);

  const loading = live.loading || (eventIds.length > 0 && events.isPending);

  return (
    <div className="flex min-h-dvh flex-col">
      <PublicNav active="live" />
      <main id="main" className="mx-auto w-full max-w-[960px] flex-1 px-[18px] pb-16 pt-8 sm:px-6 sm:pt-14">
        <Kick className="mb-2">Happening right now · no account needed</Kick>
        <h1 className="mb-7 text-[32px] font-medium leading-[1.05] tracking-[-0.03em] sm:text-[40px]">Live</h1>

        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : (live.data ?? []).length === 0 ? (
          <EmptyState title="Nothing live right now" body="Check back once a fest's matches kick off — this page updates the moment one does." />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {(live.data ?? []).map((m) => {
              const event = eventById.get(m.eventId);
              const fest = festById.get(m.festId);
              return (
                <Link key={m.id} href={`/live/${m.eventId}`} className="no-underline text-inherit">
                  <Panel className="p-5 transition hover:shadow-[0_0_0_1px_var(--color-accent)]">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[13px] font-medium">{event?.title ?? "Event"}</span>
                      <Tag tone="live">Live</Tag>
                    </div>
                    <div className="mb-3 text-[11.5px] text-neutral-500">
                      {fest?.name ?? "Fest"}
                      {m.arenaName ? ` · ${m.arenaName}` : ""}
                    </div>
                    <div className="flex items-center justify-center gap-4 text-[20px] font-medium tracking-tight">
                      <span>{m.homeTeam?.name ?? "TBD"}</span>
                      <span className="code">
                        {m.score.displayHome}–{m.score.displayAway}
                      </span>
                      <span>{m.awayTeam?.name ?? "TBD"}</span>
                    </div>
                  </Panel>
                </Link>
              );
            })}
          </div>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
