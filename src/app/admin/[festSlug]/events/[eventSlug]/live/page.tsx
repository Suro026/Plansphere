"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useFest } from "@/components/shell/admin-shell";
import { useAdminEvent } from "@/components/admin/event-context";
import { useRepositories } from "@/components/providers";
import { useEventMatches, useFestArenas } from "@/components/live/hooks";
import { MATCH_DURATION_TYPES, TOURNAMENT_TYPES, TOURNAMENT_TYPE_LABELS, type Match, type MatchConfig, type TournamentType } from "@/core/models/match";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect, Seg, CheckOption } from "@/components/ui/field";
import { EmptyState, Kick, MetaList, MetaRow, PageHeading, Panel, Skeleton, Tag } from "@/components/ui/primitives";

const numberField = (v: string): number | undefined => (v.trim() === "" ? undefined : Math.max(0, Number(v) || 0));

/**
 * 7 — Live settings: turn on the Live Event Engine for this event, pick a
 * sport and a rulebook, assign matches to arenas, and generate a bracket.
 * Everything here writes through `EventRepository.update` and
 * `MatchRepository`, so the live pages and the volunteer scorer see the
 * result immediately — there is no separate "publish" step.
 */
export default function EventLivePage() {
  const { fest } = useFest();
  const { event } = useAdminEvent();
  const repos = useRepositories();
  const arenas = useFestArenas(fest.id);
  const matches = useEventMatches(event.id);

  const [liveEnabled, setLiveEnabled] = React.useState(event.liveEnabled);
  const [tournamentType, setTournamentType] = React.useState<TournamentType>(event.tournamentType ?? "knockout");
  const [sportType, setSportType] = React.useState(event.sportType ?? "");
  const [config, setConfig] = React.useState<MatchConfig>(
    event.matchConfig ?? { durationType: "time", maxPlayers: 11, halves: 2, minutesPerHalf: 20 },
  );
  const [saving, setSaving] = React.useState(false);
  const [generating, setGenerating] = React.useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await repos.events.update(event.id, { liveEnabled, tournamentType, sportType: sportType.trim() || undefined, matchConfig: config });
      toast.success("Live settings saved");
    } catch {
      toast.error("Couldn't save live settings");
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    if (tournamentType !== "knockout" && tournamentType !== "round_robin") return;
    setGenerating(true);
    try {
      const { created } = await repos.matches.generateBracket(event.id, tournamentType);
      toast.success(`${created} match${created === 1 ? "" : "es"} generated`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't generate the bracket");
    } finally {
      setGenerating(false);
    }
  };

  const rounds = React.useMemo(() => {
    const byRound = new Map<number, Match[]>();
    for (const m of matches.data ?? []) byRound.set(m.round, [...(byRound.get(m.round) ?? []), m]);
    return [...byRound.entries()].sort(([a], [b]) => a - b);
  }, [matches.data]);

  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 py-7 lg:px-8">
      <PageHeading kick={event.title} title="Live" sub="Tournament mode, arenas and the bracket." className="mb-6" />

      <Panel className="mb-6 p-5">
        <Kick className="mb-3">Tournament</Kick>
        <CheckOption
          label="Turn on live mode for this event"
          description="Adds a public scoreboard at /live and a volunteer scorer."
          checked={liveEnabled}
          onChange={(e) => setLiveEnabled(e.target.checked)}
          className="mb-4"
        />
        {liveEnabled ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Format">
              <NativeSelect value={tournamentType} onChange={(e) => setTournamentType(e.target.value as TournamentType)}>
                {TOURNAMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TOURNAMENT_TYPE_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Sport" hint="Any sport — pick a known one or type your own.">
              <Input value={sportType} onChange={(e) => setSportType(e.target.value)} placeholder="Football, Robo Fight, Quiz…" />
            </Field>
            <Field label="Match length is measured in">
              <Seg
                value={config.durationType}
                onChange={(v) => setConfig((c) => ({ ...c, durationType: v }))}
                options={MATCH_DURATION_TYPES.map((d) => ({ value: d, label: d[0]!.toUpperCase() + d.slice(1) }))}
              />
            </Field>
            <Field label="Max players per side">
              <Input type="number" min={1} value={config.maxPlayers} onChange={(e) => setConfig((c) => ({ ...c, maxPlayers: Math.max(1, Number(e.target.value) || 1) }))} />
            </Field>
            {config.durationType === "time" ? (
              <>
                <Field label="Halves">
                  <Input type="number" min={1} value={config.halves ?? ""} onChange={(e) => setConfig((c) => ({ ...c, halves: numberField(e.target.value) }))} />
                </Field>
                <Field label="Minutes per half">
                  <Input type="number" min={1} value={config.minutesPerHalf ?? ""} onChange={(e) => setConfig((c) => ({ ...c, minutesPerHalf: numberField(e.target.value) }))} />
                </Field>
              </>
            ) : null}
            {config.durationType === "overs" ? (
              <Field label="Overs">
                <Input type="number" min={1} value={config.overs ?? ""} onChange={(e) => setConfig((c) => ({ ...c, overs: numberField(e.target.value) }))} />
              </Field>
            ) : null}
            {config.durationType === "sets" ? (
              <>
                <Field label="Sets (best of)">
                  <Input type="number" min={1} value={config.sets ?? ""} onChange={(e) => setConfig((c) => ({ ...c, sets: numberField(e.target.value) }))} />
                </Field>
                <Field label="Points per set">
                  <Input type="number" min={1} value={config.pointsPerSet ?? ""} onChange={(e) => setConfig((c) => ({ ...c, pointsPerSet: numberField(e.target.value) }))} />
                </Field>
              </>
            ) : null}
            {config.durationType === "rounds" ? (
              <Field label="Rounds (best of)">
                <Input type="number" min={1} value={config.rounds ?? ""} onChange={(e) => setConfig((c) => ({ ...c, rounds: numberField(e.target.value) }))} />
              </Field>
            ) : null}
            {config.durationType === "points" ? (
              <Field label="Target points">
                <Input type="number" min={1} value={config.targetPoints ?? ""} onChange={(e) => setConfig((c) => ({ ...c, targetPoints: numberField(e.target.value) }))} />
              </Field>
            ) : null}
          </div>
        ) : null}
        <div className="mt-5 flex items-center gap-2">
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {liveEnabled ? (
            <Button asChild variant="ghost">
              <Link href={`/live/${event.id}`} target="_blank">
                View public page
              </Link>
            </Button>
          ) : null}
        </div>
      </Panel>

      {liveEnabled ? (
        <>
          <Panel className="mb-6 p-5">
            <div className="mb-3 flex items-center justify-between">
              <Kick>Arenas</Kick>
              <Button asChild variant="ghost">
                <Link href={`/admin/${fest.slug}/arenas`}>Manage arenas</Link>
              </Button>
            </div>
            {arenas.loading ? (
              <Skeleton className="h-10" />
            ) : (arenas.data ?? []).length === 0 ? (
              <div className="text-[12.5px] text-neutral-500">No arenas yet — matches can still be scored without one, but grouping on the live page needs at least one.</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {(arenas.data ?? []).map((a) => (
                  <Tag key={a.id} tone={a.active ? "outline" : "neutral"}>
                    {a.name}
                  </Tag>
                ))}
              </div>
            )}
          </Panel>

          {(tournamentType === "knockout" || tournamentType === "round_robin") && (matches.data ?? []).length === 0 ? (
            <Panel className="mb-6 p-5">
              <Kick className="mb-3">Bracket</Kick>
              <p className="mb-4 text-[12.5px] text-neutral-500">
                Generates a {tournamentType === "knockout" ? "knockout bracket with byes" : "full round-robin"} from every confirmed entry.
              </p>
              <Button variant="primary" disabled={generating} onClick={() => void generate()}>
                {generating ? "Generating…" : "Generate bracket"}
              </Button>
            </Panel>
          ) : null}

          <Panel className="p-5">
            <Kick className="mb-3">Matches</Kick>
            {matches.loading ? (
              <Skeleton className="h-32" />
            ) : rounds.length === 0 ? (
              <EmptyState title="No matches yet" body="Generate a bracket above, or add fixtures one at a time for a swiss or custom tournament." />
            ) : (
              <div className="flex flex-col gap-5">
                {rounds.map(([round, roundMatches]) => (
                  <div key={round}>
                    <div className="mb-2 text-[12px] font-medium text-neutral-400">{roundMatches![0]!.roundLabel}</div>
                    <MetaList>
                      {roundMatches!
                        .sort((a, b) => a.matchIndex - b.matchIndex)
                        .map((m) => (
                          <MetaRow key={m.id} label={`${m.homeTeam?.name ?? "TBD"} vs ${m.awayTeam?.name ?? "TBD"}`}>
                            <span className="mr-2 code">
                              {m.score.displayHome}–{m.score.displayAway}
                            </span>
                            <Tag tone={m.status === "live" ? "accent" : m.status === "completed" ? "neutral" : "outline"}>{m.status}</Tag>
                            {m.arenaName ? <span className="ml-2 text-[11px] text-neutral-500">{m.arenaName}</span> : null}
                          </MetaRow>
                        ))}
                    </MetaList>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
