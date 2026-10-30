"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useRepositories } from "@/components/providers";
import { useEventMatches } from "@/components/live/hooks";
import { PublicFooter, PublicNav } from "@/components/shell/public-nav";
import { EmptyState, Kick, MetaList, MetaRow, Panel, Skeleton, Tag } from "@/components/ui/primitives";
import type { Match } from "@/core/models/match";
import { scoreProgress } from "@/core/services/scoring/progress";

const ScoreLine = ({ match, size = "md" }: { match: Match; size?: "md" | "lg" }) => {
  const progress = size === "lg" ? scoreProgress(match.score) : null;
  return (
    <div>
      <div className={`flex items-center justify-center gap-4 font-medium tracking-tight ${size === "lg" ? "text-[28px]" : "text-[18px]"}`}>
        <span className={match.winner === "home" ? "text-accent" : ""}>{match.homeTeam?.name ?? "TBD"}</span>
        <span className="code">
          {match.score.displayHome}–{match.score.displayAway}
        </span>
        <span className={match.winner === "away" ? "text-accent" : ""}>{match.awayTeam?.name ?? "TBD"}</span>
      </div>
      {progress ? <div className="mt-1.5 text-center text-[13px] text-neutral-400">{progress}</div> : null}
    </div>
  );
};

/**
 * 4 — one event's public live dashboard: hero, current match, next match,
 * previous result, upcoming fixtures, and the bracket. Real-time via
 * Firestore's own `onSnapshot` (through `useEventMatches`) — a genuine push
 * update beats a 5-second poll and needs no timer at all.
 */
export default function LiveEventPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const repos = useRepositories();
  const matches = useEventMatches(eventId);

  const event = useQuery({ queryKey: ["live-event", eventId], queryFn: () => repos.events.getById(eventId) });
  const fest = useQuery({
    queryKey: ["live-event-fest", event.data?.festId],
    enabled: Boolean(event.data?.festId),
    queryFn: () => repos.fests.getById(event.data!.festId),
  });

  const all = React.useMemo(() => matches.data ?? [], [matches.data]);
  const live = all.filter((m) => m.status === "live");
  const upcoming = [...all.filter((m) => m.status === "upcoming")].sort((a, b) => a.round - b.round || a.matchIndex - b.matchIndex);
  const completed = [...all.filter((m) => m.status === "completed")].sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0));
  const rounds = React.useMemo(() => {
    const byRound = new Map<number, Match[]>();
    for (const m of all) byRound.set(m.round, [...(byRound.get(m.round) ?? []), m]);
    return [...byRound.entries()].sort(([a], [b]) => a - b);
  }, [all]);

  if (event.isPending || matches.loading) {
    return (
      <div className="flex min-h-dvh flex-col">
        <PublicNav active="live" />
        <main className="mx-auto w-full max-w-[960px] flex-1 px-[18px] pt-8 sm:px-6">
          <Skeleton className="mb-6 h-24" />
          <Skeleton className="h-64" />
        </main>
      </div>
    );
  }

  if (!event.data) {
    return (
      <div className="flex min-h-dvh flex-col">
        <PublicNav active="live" />
        <main className="mx-auto w-full max-w-[720px] flex-1 px-[18px] py-16">
          <EmptyState title="No such event" body="It may have ended its run, or the link is wrong." />
        </main>
        <PublicFooter />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <PublicNav active="live" />
      <main id="main" className="mx-auto w-full max-w-[960px] flex-1 px-[18px] pb-16 pt-8 sm:px-6 sm:pt-14">
        <div className="mb-7 flex items-center gap-3">
          {live.length > 0 ? <Tag tone="live">Live</Tag> : null}
          <Kick>{fest.data?.name ?? "Fest"}</Kick>
        </div>
        <h1 className="mb-8 text-[32px] font-medium leading-[1.05] tracking-[-0.03em] sm:text-[40px]">{event.data.title}</h1>

        {live.length > 0 ? (
          <section className="mb-8">
            <Kick className="mb-3">{live.length > 1 ? "Current matches" : "Current match"}</Kick>
            <div className="grid gap-4 sm:grid-cols-2">
              {live.map((m) => (
                <Panel key={m.id} className="p-6 text-center">
                  <div className="mb-2 text-[11.5px] text-neutral-500">
                    {m.roundLabel}
                    {m.arenaName ? ` · ${m.arenaName}` : ""}
                  </div>
                  <ScoreLine match={m} size="lg" />
                  {m.paused ? <Tag tone="outline" className="mt-3">Paused</Tag> : null}
                </Panel>
              ))}
            </div>
          </section>
        ) : null}

        <div className="mb-8 grid gap-6 sm:grid-cols-2">
          <section>
            <Kick className="mb-3">Next match</Kick>
            {upcoming[0] ? (
              <Panel className="p-4">
                <MetaRow label={upcoming[0].roundLabel}>
                  {upcoming[0].homeTeam?.name ?? "TBD"} vs {upcoming[0].awayTeam?.name ?? "TBD"}
                </MetaRow>
              </Panel>
            ) : (
              <div className="text-[12.5px] text-neutral-500">Nothing scheduled yet.</div>
            )}
          </section>
          <section>
            <Kick className="mb-3">Previous result</Kick>
            {completed[0] ? (
              <Panel className="p-4">
                <MetaRow label={completed[0].roundLabel}>
                  <span className="code">
                    {completed[0].score.displayHome}–{completed[0].score.displayAway}
                  </span>
                </MetaRow>
              </Panel>
            ) : (
              <div className="text-[12.5px] text-neutral-500">No results yet.</div>
            )}
          </section>
        </div>

        {upcoming.length > 0 ? (
          <section className="mb-8">
            <Kick className="mb-3">Upcoming fixtures</Kick>
            <MetaList>
              {upcoming.slice(0, 10).map((m) => (
                <MetaRow key={m.id} label={m.roundLabel}>
                  {m.homeTeam?.name ?? "TBD"} vs {m.awayTeam?.name ?? "TBD"}
                  {m.arenaName ? ` · ${m.arenaName}` : ""}
                </MetaRow>
              ))}
            </MetaList>
          </section>
        ) : null}

        {rounds.length > 0 ? (
          <section>
            <Kick className="mb-3">Bracket</Kick>
            <div className="flex gap-6 overflow-x-auto pb-2">
              {rounds.map(([round, roundMatches]) => (
                <div key={round} className="flex min-w-[220px] flex-col gap-3">
                  <div className="text-[11px] font-medium text-neutral-400">{roundMatches[0]!.roundLabel}</div>
                  {roundMatches
                    .sort((a, b) => a.matchIndex - b.matchIndex)
                    .map((m) => (
                      <Panel key={m.id} className="p-3">
                        <div className={`text-[12.5px] ${m.winner === "home" ? "font-medium text-accent" : ""}`}>{m.homeTeam?.name ?? "TBD"}</div>
                        <div className={`text-[12.5px] ${m.winner === "away" ? "font-medium text-accent" : ""}`}>{m.awayTeam?.name ?? "TBD"}</div>
                        <div className="mt-1 text-[10.5px] text-neutral-500">
                          {m.status === "upcoming" ? "Not started" : `${m.score.displayHome}–${m.score.displayAway}`}
                        </div>
                      </Panel>
                    ))}
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </main>
      <PublicFooter />
    </div>
  );
}
