"use client";

import * as React from "react";
import { toast } from "sonner";
import { useAuth, useRepositories } from "@/components/providers";
import { useVolunteerFest } from "@/components/shell/volunteer-shell";
import { useArenaMatches, useFestArenas, useMatchLog, useMyScoringArenaIds } from "@/components/live/hooks";
import { ScoreControls } from "@/components/live/score-controls";
import type { Match, MatchSide } from "@/core/models/match";
import { isFinalMatch } from "@/core/models/match";
import { scoreProgress } from "@/core/services/scoring/progress";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/field";
import { EmptyState, Kick, MetaList, MetaRow, PageHeading, Panel, Skeleton, Tag, Timeline, TimelineItem } from "@/components/ui/primitives";
import { formatClock } from "@/lib/utils";

/**
 * 6 — the volunteer's own scorer. Shows only the arenas their shift assigns
 * them to (`useMyScoringArenaIds`), and only matches at whichever arena is
 * selected — the server enforces the same boundary on every write, but the
 * UI narrowing it too is what keeps a volunteer from ever seeing a "Start"
 * button on a match they cannot press.
 */
export default function VolunteerLivePage() {
  const { fest } = useVolunteerFest();
  const { session } = useAuth();
  const repos = useRepositories();
  const arenaIds = useMyScoringArenaIds(fest.id, session?.uid);
  const arenas = useFestArenas(fest.id);
  const myArenas = React.useMemo(() => (arenas.data ?? []).filter((a) => arenaIds.has(a.id)), [arenas.data, arenaIds]);

  const [arenaId, setArenaId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!arenaId && myArenas[0]) setArenaId(myArenas[0].id);
  }, [myArenas, arenaId]);

  const matches = useArenaMatches(arenaId ?? undefined);
  const [matchId, setMatchId] = React.useState<string | null>(null);
  const match = (matches.data ?? []).find((m) => m.id === matchId) ?? null;
  const log = useMatchLog(matchId ?? undefined);

  const [busy, setBusy] = React.useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn't go through");
    } finally {
      setBusy(false);
    }
  };

  if (arenas.loading) return <Skeleton className="m-5 h-64" />;

  if (myArenas.length === 0) {
    return (
      <div className="px-[18px] py-10">
        <EmptyState title="No arena assigned yet" body="Ask an admin to assign you to an arena from Arenas → Assign a volunteer." />
      </div>
    );
  }

  return (
    <div className="px-[18px] pb-10 pt-4">
      <PageHeading kick={fest.name} title="Live scoring" className="mb-4" />

      {myArenas.length > 1 ? (
        <NativeSelect className="mb-4" value={arenaId ?? ""} onChange={(e) => { setArenaId(e.target.value); setMatchId(null); }}>
          {myArenas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </NativeSelect>
      ) : null}

      {!match ? (
        <>
          <Kick className="mb-3">Matches at {myArenas.find((a) => a.id === arenaId)?.name}</Kick>
          {matches.loading ? (
            <Skeleton className="h-32" />
          ) : (matches.data ?? []).filter((m) => m.status !== "cancelled").length === 0 ? (
            <EmptyState title="No matches here yet" body="An admin assigns matches to this arena from an event's Live tab." />
          ) : (
            <MetaList>
              {(matches.data ?? [])
                .filter((m) => m.status !== "cancelled")
                .map((m) => (
                  <button key={m.id} type="button" onClick={() => setMatchId(m.id)} className="w-full cursor-pointer border-0 bg-transparent p-0 text-left">
                    <MetaRow label={`${m.homeTeam?.name ?? "TBD"} vs ${m.awayTeam?.name ?? "TBD"}`}>
                      <Tag tone={m.status === "live" ? "accent" : m.status === "completed" ? "neutral" : "outline"}>{m.status}</Tag>
                    </MetaRow>
                  </button>
                ))}
            </MetaList>
          )}
        </>
      ) : (
        <MatchScorer match={match} entries={log.data ?? []} busy={busy} onBack={() => setMatchId(null)} run={run} scoreMatch={(a, s, p) => repos.matches.scoreMatch(match.id, { type: a, side: s, payload: p })} matchesRepo={repos.matches} />
      )}
    </div>
  );
}

const MatchScorer = ({
  match,
  entries,
  busy,
  onBack,
  run,
  scoreMatch,
  matchesRepo,
}: {
  match: Match;
  entries: import("@/core/models/match-log").MatchLogEntry[];
  busy: boolean;
  onBack: () => void;
  run: (fn: () => Promise<void>) => Promise<void>;
  scoreMatch: (type: string, side?: MatchSide, payload?: Record<string, unknown>) => Promise<void>;
  matchesRepo: import("@/core/repositories/match-repository").MatchRepository;
}) => {
  const [winner, setWinner] = React.useState<MatchSide | "">("");

  return (
    <div>
      <Button variant="ghost" onClick={onBack} className="mb-3">
        ← All matches
      </Button>

      <Panel className="mb-4 p-5 text-center">
        <div className="mb-1 text-[12px] text-neutral-500">
          {match.roundLabel} {isFinalMatch(match) ? "· Final" : ""}
        </div>
        <div className="flex items-center justify-center gap-6">
          <div className="text-[15px] font-medium">{match.homeTeam?.name ?? "TBD"}</div>
          <div className="text-[34px] font-medium tracking-tight">
            {match.score.displayHome} – {match.score.displayAway}
          </div>
          <div className="text-[15px] font-medium">{match.awayTeam?.name ?? "TBD"}</div>
        </div>
        {scoreProgress(match.score) ? <div className="mt-1 text-[12.5px] text-neutral-400">{scoreProgress(match.score)}</div> : null}
        <Tag tone={match.status === "live" ? "accent" : match.status === "completed" ? "neutral" : "outline"} className="mt-2">
          {match.paused ? "Paused" : match.status}
        </Tag>
      </Panel>

      <div className="mb-5 flex flex-wrap gap-2">
        {match.status === "upcoming" ? (
          <Button variant="primary" disabled={busy} onClick={() => void run(() => matchesRepo.startMatch(match.id))}>
            Start
          </Button>
        ) : null}
        {match.status === "live" && !match.paused ? (
          <Button variant="secondary" disabled={busy} onClick={() => void run(() => matchesRepo.pauseMatch(match.id))}>
            Pause
          </Button>
        ) : null}
        {match.status === "live" && match.paused ? (
          <Button variant="secondary" disabled={busy} onClick={() => void run(() => matchesRepo.resumeMatch(match.id))}>
            Resume
          </Button>
        ) : null}
        {match.status === "live" ? (
          <Button variant="ghost" disabled={busy} onClick={() => void run(() => matchesRepo.undoLastAction(match.id))}>
            Undo last
          </Button>
        ) : null}
        {match.status === "live" ? (
          <div className="flex items-center gap-2">
            {match.score.home === match.score.away ? (
              <NativeSelect value={winner} onChange={(e) => setWinner(e.target.value as MatchSide | "")}>
                <option value="">Pick a winner…</option>
                <option value="home">{match.homeTeam?.name ?? "Home"}</option>
                <option value="away">{match.awayTeam?.name ?? "Away"}</option>
              </NativeSelect>
            ) : null}
            <Button
              variant="primary"
              disabled={busy || (match.score.home === match.score.away && !winner)}
              onClick={() => void run(() => matchesRepo.finishMatch(match.id, winner || undefined))}
            >
              Finish
            </Button>
          </div>
        ) : null}
      </div>

      {match.status === "live" ? <ScoreControls match={match} busy={busy} onScore={scoreMatch} /> : null}

      <Kick className="mb-2 mt-6">Timeline</Kick>
      {entries.length === 0 ? (
        <div className="text-[12.5px] text-neutral-500">Nothing recorded yet.</div>
      ) : (
        <Timeline>
          {[...entries]
            .sort((a, b) => b.at.getTime() - a.at.getTime())
            .map((e) => (
              <TimelineItem key={e.id} title={e.undone ? `${e.label} (undone)` : e.label} meta={formatClock(e.at)} />
            ))}
        </Timeline>
      )}
    </div>
  );
};
