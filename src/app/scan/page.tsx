"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Check, Flashlight, MagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
import { useAuth, useRepositories } from "@/components/providers";
import { useMemberFests, useMyAccess } from "@/components/admin/members-api";
import { RequireRole } from "@/components/shell/require-role";
import { Camera, type CameraHandle } from "@/components/scanner/camera";
import {
  UNDO_WINDOW_MS,
  canUndo,
  decideEntry,
  decideMeal,
  manualSearch,
  parseTicketCode,
  peekEntry,
  peekMeal,
  undoRemainingMs,
  undoScan,
  useScannerSync,
  type PeekResult,
} from "@/lib/offline/scanner";
import { listToday, type HistoryEntry, type RosterEntry } from "@/lib/offline/db";
import { Seg, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogActions, DialogContent } from "@/components/ui/overlays";
import { EmptyState, MetaList, MetaRow, Reveal, Skeleton, StatusBanner, Tag } from "@/components/ui/primitives";
import type { MealType, ScanOutcome } from "@/core/models/attendance";
import { formatCalendarDate, formatClock, formatClockSeconds, formatRelative } from "@/lib/utils";

type Mode = "entry" | "meal";

export default function ScanPage() {
  return (
    <RequireRole minimum="volunteer" fallback="/explore">
      <React.Suspense fallback={<div className="min-h-dvh bg-neutral-900" />}>
        <Scanner />
      </React.Suspense>
    </RequireRole>
  );
}

/**
 * 2c / 3e — the gate scanner.
 *
 * Dark chrome (neutral-900) so the camera reads as the page; the accent inset
 * frame for an accepted scan, the neutral one for a duplicate. Every decision
 * is made locally against the cached roster; the sync banner says exactly how
 * many writes are waiting.
 *
 * A team shares one QR. Scanning it never marks the whole team by surprise:
 * for anyone with more than one member on the ticket, the scan is a *look*
 * first — who has arrived, who has not — and the volunteer ticks who is
 * actually here before anything is written. A solo ticket has nothing to
 * choose, so it stays one tap.
 */
const Scanner = () => {
  const { session, profile } = useAuth();
  const repos = useRepositories();
  const router = useRouter();
  const params = useSearchParams();
  const festSlug = params.get("fest") ?? "";
  const eventSlug = params.get("event") ?? "";
  const eventId = params.get("eventId") ?? "";
  const mode = (params.get("mode") === "meal" ? "meal" : "entry") as Mode;
  const gate = params.get("gate") ?? undefined;
  const openSearch = params.get("search") === "1";

  const fest = useQuery({ queryKey: ["fest-slug", festSlug], enabled: Boolean(festSlug), queryFn: () => repos.fests.getBySlug(festSlug) });
  const events = useQuery({
    queryKey: ["fest-events-scan", fest.data?.id],
    enabled: Boolean(fest.data),
    queryFn: () => repos.events.list({ festId: fest.data!.id, status: ["published", "ongoing"], limit: 200 }).then((p) => p.items),
  });
  // A volunteer with an event role is offered only the competitions they are assigned to. (The server refuses the rest
  // regardless; this just keeps the picker honest.)
  const memberFests = useMemberFests();
  const access = useMyAccess(memberFests.ids.length > 0);
  const membership = access.data?.memberships.find((m) => m.festId === fest.data?.id);
  const visibleEvents = React.useMemo(
    () => (events.data ?? []).filter((e) => !membership || membership.role === "head" || membership.eventIds.includes(e.id)),
    [events.data, membership],
  );
  const event = React.useMemo(
    () => visibleEvents.find((e) => (eventSlug ? e.slug === eventSlug : eventId ? e.id === eventId : false)) ?? null,
    [visibleEvents, eventSlug, eventId],
  );

  const sync = useScannerSync(repos, session?.uid, event);
  const camera = React.useRef<CameraHandle>(null);
  const [outcome, setOutcome] = React.useState<ScanOutcome | null>(null);
  const [lastHistoryId, setLastHistoryId] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<{ code: string; peek: PeekResult } | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [manual, setManual] = React.useState(false);
  const [manualCode, setManualCode] = React.useState("");
  const [search, setSearch] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [searchTerm, setSearchTerm] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<RosterEntry[]>([]);
  const [history, setHistory] = React.useState(false);
  const [cameraError, setCameraError] = React.useState<string | null>(null);
  const [torch, setTorch] = React.useState(false);
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0);
  const today = new Date().toISOString().slice(0, 10);
  const [mealType, setMealType] = React.useState<MealType>(() => {
    const h = new Date().getHours();
    return h < 11 ? "breakfast" : h < 16 ? "lunch" : h < 21 ? "dinner" : "snack";
  });

  const busy = React.useRef(false);

  // Ticks once a second while an undo window is open, so the countdown moves.
  React.useEffect(() => {
    if (!lastHistoryId) return;
    const id = setInterval(forceTick, 1000);
    return () => clearInterval(id);
  }, [lastHistoryId]);

  // "Manual search" from the dashboard skips straight past the camera.
  React.useEffect(() => {
    if (openSearch && event) setSearch(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSearch, event?.id]);

  const commit = React.useCallback(
    async (code: string, memberKeys?: string[]) => {
      if (!event || !session) return;
      const result =
        mode === "meal"
          ? await decideMeal({ event, code, gate, scannedBy: session.uid, online: sync.online, mealType, servedOn: today, post: gate, ...(memberKeys ? { memberKeys } : {}) })
          : await decideEntry({ event, code, gate, scannedBy: session.uid, online: sync.online, ...(memberKeys ? { memberKeys } : {}) });

      setOutcome(result);
      setPreview(null);
      if (result.result === "ok") {
        const recent = await listToday(event.id);
        setLastHistoryId(recent[0]?.id ?? null);
      } else {
        setLastHistoryId(null);
      }
      if (navigator.vibrate) navigator.vibrate(result.result === "ok" ? 40 : [30, 60, 30]);
      if (sync.online) void sync.sync();
      else void sync.refreshState();
    },
    [event, session, mode, gate, mealType, today, sync],
  );

  const handle = React.useCallback(
    async (raw: string) => {
      if (!event || !session || busy.current) return;
      const code = parseTicketCode(raw);
      if (!code) {
        setOutcome({ result: "not-found" });
        return;
      }
      busy.current = true;
      try {
        const peek = mode === "meal" ? await peekMeal(event.id, code, mealType, today) : await peekEntry(event.id, code);

        // Nothing to choose: a solo ticket, an error, or a team already fully
        // marked. Commit straight away — the existing single-tap flow.
        if (peek.result !== "ready" || peek.registration.memberCount <= 1 || peek.complete) {
          if (peek.result === "ready") await commit(code);
          else {
            setOutcome(peek);
            setPreview(null);
          }
          return;
        }

        // A team with someone still outstanding: show the checklist rather
        // than guessing who is actually present.
        setPreview({ code, peek });
        setSelected(new Set(peek.members.filter((m) => !m.done).map((m) => m.key)));
      } finally {
        busy.current = false;
      }
    },
    [event, session, mode, mealType, today, commit],
  );

  const runSearch = React.useCallback(
    async (term: string) => {
      setSearchTerm(term);
      if (!event || term.trim().length < 2) {
        setSearchResults([]);
        return;
      }
      setSearching(true);
      try {
        setSearchResults(await manualSearch(event.id, term));
      } finally {
        setSearching(false);
      }
    },
    [event],
  );

  const undo = async () => {
    if (!lastHistoryId) return;
    const result = await undoScan(lastHistoryId);
    if (result.ok) {
      setLastHistoryId(null);
      setOutcome(null);
      await sync.refreshState();
    }
  };

  const scansToday = sync.history.filter((h) => h.outcome === "ok" && new Date(h.at).toISOString().slice(0, 10) === today).length;
  const scannerName = profile?.fullName?.split(/\s+/)[0] ?? "you";

  /* ── choose an event ── */
  if (!festSlug) {
    return (
      <Shell title="Scanner" sub="Pick a fest">
        <div className="p-[18px]">
          <EmptyState title="Which fest?" body="Open the scanner from the Gate page of a fest, or from your volunteer shifts." action={<Button asChild variant="primary"><Link href="/admin">Admin</Link></Button>} />
        </div>
      </Shell>
    );
  }
  if (fest.isPending || events.isPending) {
    return (
      <Shell title="Scanner" sub="Loading…">
        <div className="p-[18px]">
          <Skeleton className="h-64" />
        </div>
      </Shell>
    );
  }
  if (!fest.data) {
    return (
      <Shell title="Scanner" sub="Unknown fest">
        <div className="p-[18px]">
          <EmptyState title="No such fest" body="Check the link you followed." />
        </div>
      </Shell>
    );
  }
  if (!event) {
    const todays = visibleEvents.filter((e) => e.date === today);
    const list = todays.length ? todays : visibleEvents;
    return (
      <Shell title={fest.data.name} sub="Choose the event you are scanning for">
        <div className="flex flex-col gap-2 p-[18px]">
          {list.length === 0 ? (
            <EmptyState title="No published events" body="Nothing to scan for yet." />
          ) : (
            list.map((e) => (
              <button
                key={e.id}
                type="button"
                className="panel flex items-center justify-between gap-3 px-3.5 py-3 text-left hover:bg-surface"
                onClick={() => router.replace(`/scan?fest=${festSlug}&event=${e.slug}&mode=${mode}${gate ? `&gate=${encodeURIComponent(gate)}` : ""}`)}
              >
                <div>
                  <div className="text-[14px] font-medium">{e.title}</div>
                  <div className="text-[11.5px] text-neutral-500">
                    {formatCalendarDate(e.date)} · {e.startTime} · {e.venue}
                  </div>
                </div>
                <Tag tone={e.status === "ongoing" ? "accent" : "neutral"}>{e.status === "ongoing" ? "Live" : "Published"}</Tag>
              </button>
            ))
          )}
        </div>
      </Shell>
    );
  }

  /* ── the team checklist: who is actually here ── */
  if (preview && preview.peek.result === "ready") {
    const { registration, members } = preview.peek;
    const toggle = (key: string) => {
      // A member already marked cannot be unmarked from here — that would
      // let one scan quietly undo a record another scan already made. Undo
      // exists for a mistake made seconds ago; this is not that.
      if (members.find((m) => m.key === key)?.done) return;
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    };

    return (
      <Shell title={event.title} sub={`${gate ?? (mode === "meal" ? "Food counter" : "Gate")} · ${scannerName}`} mode={mode}>
        <div className="flex flex-1 flex-col">
          <div className="px-[18px] pt-4">
            <div className="text-[20px] font-medium tracking-[-0.015em]">{registration.teamName ?? registration.userName}</div>
            <div className="mt-1 text-[12.5px] text-neutral-500">
              {registration.teamName ? `Team · ${registration.memberCount} members` : registration.userName} · {registration.ticketCode}
            </div>
          </div>
          <div className="mt-3.5 flex flex-col gap-[7px] px-[18px]">
            {members.map((member) => (
              <label
                key={member.key}
                className={`panel flex items-center gap-3 px-3.5 py-3 ${member.done ? "opacity-60" : "cursor-pointer"}`}
              >
                <input
                  type="checkbox"
                  checked={member.done || selected.has(member.key)}
                  disabled={member.done}
                  onChange={() => toggle(member.key)}
                  className="h-[18px] w-[18px] flex-none accent-accent"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px]">{member.name}</div>
                  <div className="truncate text-[11px] text-neutral-500">{member.email}</div>
                </div>
                {member.done ? <Tag tone="accent" check>{mode === "meal" ? "Served" : "Present"}</Tag> : null}
              </label>
            ))}
          </div>
          <div className="mt-3 px-[18px] text-[12px] text-neutral-500">
            {mode === "meal"
              ? "Mark only who is collecting this round. Scan the same QR again for anyone who arrives later."
              : "Late arrivals scan the same QR again — only the ones you tick here are marked now."}
          </div>
        </div>
        <div className="flex gap-[9px] border-t border-divider bg-bg px-[18px] pb-[calc(22px+env(safe-area-inset-bottom))] pt-3.5">
          <Button variant="secondary" className="flex-1" onClick={() => setPreview(null)}>
            Cancel
          </Button>
          <Button variant="primary" className="flex-1" disabled={selected.size === 0} onClick={() => void commit(preview.code, [...selected])}>
            {mode === "meal" ? `Serve ${selected.size || ""}` : `Mark ${selected.size || ""} present`}
          </Button>
        </div>
      </Shell>
    );
  }

  /* ── result screens ── */
  if (outcome) {
    const next = () => {
      setOutcome(null);
      setLastHistoryId(null);
    };
    const mealLabel = mealType[0]!.toUpperCase() + mealType.slice(1);
    const remainingMs = lastHistoryId ? undoRemainingMs({ at: Date.now() }) : 0;

    if (outcome.result === "ok") {
      const outstanding = (outcome.members ?? []).filter((m) => !m.done);
      return (
        <Shell title={event.title} sub={`${gate ?? (mode === "meal" ? "Food counter" : "Gate")} · ${scannerName}`} mode={mode} bare>
          <div className="flex flex-1 flex-col justify-center px-[22px] shadow-[inset_0_0_0_3px_var(--color-accent)]">
            <div className="animate-pop mb-5 grid h-16 w-16 place-items-center rounded-full text-accent shadow-[inset_0_0_0_2px_var(--color-accent)]">
              <Check size={30} weight="bold" />
            </div>
            <Reveal delay={80} className="text-[34px] font-medium leading-[1.05] tracking-[-0.025em]">{mode === "meal" ? `${mealLabel} served` : "Checked in"}</Reveal>
            <div className="mt-3 text-[15px] text-neutral-300">
              {outcome.marked && outcome.marked.length < outcome.registration.memberCount
                ? (outcome.members ?? []).filter((m) => outcome.marked?.includes(m.key)).map((m) => m.name).join(", ")
                : outcome.registration.userName}
              {outcome.registration.teamName ? ` · Team ${outcome.registration.teamName}` : ""}
            </div>
            <div className="code mt-[5px] text-neutral-500">{outcome.registration.ticketCode}</div>
            <MetaList className="mt-[22px]">
              {mode === "meal" && outcome.serving ? (
                <MetaRow label="Team progress">
                  {outcome.serving.n} of {outcome.serving.of} served
                </MetaRow>
              ) : outcome.registration.memberCount > 1 ? (
                <MetaRow label="Team">
                  {outcome.registration.teamName ?? "Team"} · {outcome.registration.memberCount - outstanding.length} of {outcome.registration.memberCount} {mode === "meal" ? "served" : "present"}
                </MetaRow>
              ) : null}
              {mode === "meal" ? <MetaRow label="This slot">{`Day · ${formatCalendarDate(today)} ${mealLabel.toLowerCase()} · ${formatClock(new Date())}`}</MetaRow> : null}
              <MetaRow label="Recorded">
                {formatClockSeconds(new Date())}
                {outcome.queued && !sync.online ? " · queued offline" : ""}
              </MetaRow>
              <MetaRow label={mode === "meal" ? "Served by" : "Scanned by"}>
                {scannerName}
                {gate ? ` · ${gate}` : ""}
              </MetaRow>
            </MetaList>
            {outstanding.length > 0 ? (
              <div className="mt-4 text-[12.5px] text-accent-300">
                Still to come: {outstanding.map((m) => m.name).join(", ")} — scan the same QR again when they arrive.
              </div>
            ) : mode === "meal" ? (
              <div className="mt-4 text-[12.5px] text-neutral-400">A second scan for the same slot is refused, not double counted.</div>
            ) : null}
          </div>
          <div className="px-[18px] pb-[calc(22px+env(safe-area-inset-bottom))] pt-3.5">
            {lastHistoryId && remainingMs > 0 ? (
              <Button variant="secondary" block className="mb-2" onClick={undo}>
                Undo · {Math.ceil(remainingMs / 1000)}s
              </Button>
            ) : null}
            <Button variant="primary" size="lg" block onClick={next}>
              Scan next
            </Button>
          </div>
        </Shell>
      );
    }

    if (outcome.result === "already-recorded") {
      return (
        <Shell title={event.title} sub={`${gate ?? "Gate"} · ${scannerName}`} mode={mode} bare>
          <div className="flex flex-1 flex-col justify-center px-[22px] shadow-[inset_0_0_0_3px_var(--color-neutral-700)]">
            <div className="animate-pop mb-5 grid h-16 w-16 place-items-center rounded-full text-neutral-300 shadow-[inset_0_0_0_2px_var(--color-neutral-500)]">
              <WarningCircle size={30} />
            </div>
            <div className="text-[34px] font-medium leading-[1.05] tracking-[-0.025em]">
              Already
              <br />
              {mode === "meal" ? "served" : "checked in"}
            </div>
            <MetaList className="mt-[22px]">
              <MetaRow label={mode === "meal" ? "Served" : "First scan"}>{formatClockSeconds(outcome.at)}</MetaRow>
              {outcome.by ? <MetaRow label="By">{outcome.by}</MetaRow> : null}
              <MetaRow label="Counted">Once — not double counted</MetaRow>
            </MetaList>
            <div className="mt-[18px] text-[12.5px] text-neutral-400">Send to a coordinator if this person disputes the record.</div>
          </div>
          <div className="flex gap-[9px] px-[18px] pb-[calc(22px+env(safe-area-inset-bottom))] pt-3.5">
            <Button variant="secondary" className="flex-1" onClick={next}>
              Flag for review
            </Button>
            <Button variant="primary" className="flex-1" onClick={next}>
              Scan next
            </Button>
          </div>
        </Shell>
      );
    }

    // not-found / wrong-event / cancelled / unpaid
    const title = outcome.result === "cancelled" ? "Cancelled" : outcome.result === "waitlisted" ? "On the waitlist" : outcome.result === "draft" ? "Team not complete" : outcome.result === "unpaid" ? "Payment pending" : outcome.result === "wrong-event" ? "Wrong event" : "Not a valid ticket";
    const body =
      outcome.result === "cancelled"
        ? "This registration was cancelled. Send them to the help desk."
        : outcome.result === "draft"
          ? "This team hasn’t reached its minimum size, so its ticket isn’t valid yet. Send them to the help desk."
          : outcome.result === "waitlisted"
          ? "This entry is on the waitlist — no seat is held. Send them to the help desk."
          : outcome.result === "unpaid"
          ? "This seat hasn’t been paid for, so the pass isn’t valid yet. Send them to the help desk."
        : outcome.result === "wrong-event"
          ? `This ticket is for ${outcome.expectedEventTitle}. Send them to that gate.`
          : "This code doesn’t match any registration for this event. It may be for a different fest, or the QR may have been altered.";
    return (
      <Shell title={event.title} sub={`${gate ?? "Gate"} · ${scannerName}`} mode={mode} bare>
        <div className="flex flex-1 flex-col justify-center px-[22px] shadow-[inset_0_0_0_3px_var(--color-neutral-700)]">
          <div className="animate-pop mb-5 grid h-16 w-16 place-items-center rounded-full text-neutral-300 shadow-[inset_0_0_0_2px_var(--color-neutral-500)]">
            <WarningCircle size={30} />
          </div>
          <div className="text-[34px] font-medium leading-[1.05] tracking-[-0.025em]">{title}</div>
          <div className="mt-3 max-w-[40ch] text-[14px] text-neutral-300">{body}</div>
          <MetaList className="mt-[22px]">
            <MetaRow label="What to do">Ask the participant to open My pass</MetaRow>
            {!sync.online ? <MetaRow label="Note">You’re offline — a registration made in the last few minutes may not be in this device’s roster yet.</MetaRow> : null}
          </MetaList>
        </div>
        <div className="flex gap-[9px] px-[18px] pb-[calc(22px+env(safe-area-inset-bottom))] pt-3.5">
          <Button variant="secondary" className="flex-1" onClick={() => { setOutcome(null); setManual(true); }}>
            Enter code
          </Button>
          <Button variant="primary" className="flex-1" onClick={next}>
            Scan next
          </Button>
        </div>
      </Shell>
    );
  }

  /* ── idle: camera ── */
  return (
    <Shell title={event.title} sub={`${gate ?? (mode === "meal" ? "Food counter" : "Gate")} · ${scannerName}`} mode={mode} bare>
      <div className="px-[18px] pb-3 pt-1">
        {mode === "meal" ? (
          <>
            <Seg
              fill
              value={mealType}
              onChange={setMealType}
              options={(["breakfast", "lunch", "dinner", "snack"] as MealType[]).map((m) => ({ value: m, label: m[0]!.toUpperCase() + m.slice(1) }))}
              aria-label="Meal"
            />
            <div className="mt-[9px] text-[11.5px] text-neutral-500">
              {formatCalendarDate(today)} · one serving per person per slot
            </div>
          </>
        ) : null}
        {!sync.online ? (
          <StatusBanner className="mt-2" trailing={sync.pending ? "Retrying when online" : undefined}>
            Offline — {sync.pending} scan{sync.pending === 1 ? "" : "s"} queued
          </StatusBanner>
        ) : sync.pending > 0 ? (
          <StatusBanner className="mt-2" trailing={sync.syncing ? "Syncing…" : "Retrying"}>
            {sync.pending} scan{sync.pending === 1 ? "" : "s"} waiting to sync
          </StatusBanner>
        ) : null}
      </div>

      <div className="relative flex-1 overflow-hidden bg-neutral-900">
        {cameraError ? (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div>
              <div className="text-[14px]">{cameraError}</div>
              <Button variant="secondary" className="mt-3" onClick={() => setManual(true)}>
                Enter code manually
              </Button>
            </div>
          </div>
        ) : (
          <Camera ref={camera} active={!manual && !search} onDecode={handle} onError={setCameraError} className="absolute inset-0 [&_video]:h-full [&_video]:w-full [&_video]:object-cover" />
        )}
        <div className="viewfinder pointer-events-none absolute left-[52px] right-[52px] top-1/2 aspect-square -translate-y-1/2">
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-[18px] text-center text-[13px] text-neutral-300">Point at the ticket QR</div>
      </div>

      <div className="border-t border-divider bg-bg px-[18px] pb-[calc(22px+env(safe-area-inset-bottom))] pt-3.5">
        <div className="flex gap-[9px]">
          <Button variant="secondary" className="flex-1" onClick={() => setManual(true)}>
            Enter code
          </Button>
          <Button variant="secondary" className="flex-1" onClick={() => { setSearch(true); void runSearch(""); }}>
            <MagnifyingGlass size={15} /> Search
          </Button>
          <Button
            variant="secondary"
            size="icon"
            aria-label="Torch"
            aria-pressed={torch}
            disabled={!camera.current?.torchSupported}
            onClick={async () => setTorch((await camera.current?.toggleTorch()) ?? false)}
          >
            <Flashlight size={18} weight={torch ? "fill" : "regular"} />
          </Button>
        </div>
        <div className="mt-[9px] flex justify-between text-[11.5px] text-neutral-500">
          <button type="button" className="underline decoration-dotted underline-offset-2" onClick={() => setHistory(true)}>
            {sync.lastSyncAt ? `Last sync ${formatRelative(sync.lastSyncAt)}` : sync.online ? "Synced" : "Never synced"} · {scansToday} scan{scansToday === 1 ? "" : "s"} today
          </button>
          <span>
            {sync.rosterCount} on roster{sync.rosterRefreshedAt ? ` · ${formatRelative(sync.rosterRefreshedAt)}` : ""}
          </span>
        </div>
      </div>

      <Dialog open={manual} onOpenChange={setManual}>
        <DialogContent title="Enter ticket code" description="Printed under the QR on the participant's pass.">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setManual(false);
              void handle(manualCode);
              setManualCode("");
            }}
            className="flex flex-col gap-3"
          >
            <Input value={manualCode} onChange={(e) => setManualCode(e.target.value.toUpperCase())} placeholder="PS-XXXXXXXXXX" className="code text-[15px] tracking-[0.12em]" autoFocus autoCapitalize="characters" autoCorrect="off" spellCheck={false} />
            <DialogActions>
              <Button type="submit" variant="primary" disabled={!parseTicketCode(manualCode)}>
                Check
              </Button>
            </DialogActions>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={search} onOpenChange={setSearch}>
        <DialogContent title="Find a registration" description="By registration id, ticket code, team name or student name.">
          <Input
            value={searchTerm}
            onChange={(e) => void runSearch(e.target.value)}
            placeholder="Rahul, Null Pointers, +91…"
            autoFocus
            className="mb-3"
          />
          {searching ? (
            <Skeleton className="h-24" />
          ) : searchTerm.trim().length < 2 ? (
            <div className="py-6 text-center text-[12.5px] text-neutral-500">Type at least two characters.</div>
          ) : searchResults.length === 0 ? (
            <div className="py-6 text-center text-[12.5px] text-neutral-500">Nothing on the roster matches.</div>
          ) : (
            <div className="flex max-h-[320px] flex-col gap-1.5 overflow-y-auto">
              {searchResults.map((row) => (
                <button
                  key={row.registrationId}
                  type="button"
                  className="panel flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface"
                  onClick={() => {
                    setSearch(false);
                    void handle(row.ticketCode);
                  }}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px]">{row.teamName ?? row.userName}</div>
                    <div className="truncate text-[11px] text-neutral-500">
                      {row.teamName ? `${row.userName} · ` : ""}
                      {row.ticketCode}
                    </div>
                  </div>
                  <Tag tone={row.status === "cancelled" ? "neutral" : "outline"}>{row.status}</Tag>
                </button>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <HistoryDialog open={history} onClose={() => setHistory(false)} eventId={event.id} gate={gate} />
    </Shell>
  );
};

/**
 * Today's scans from this device — the columns the spec asks for, and
 * nothing to export. `listToday` is read fresh on open rather than reused
 * from the live sync state, so a scan made a minute ago while the dialog was
 * closed is not missing from it.
 */
const HistoryDialog = ({ open, onClose, eventId, gate }: { open: boolean; onClose: () => void; eventId: string; gate?: string }) => {
  const [rows, setRows] = React.useState<HistoryEntry[]>([]);
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => {
    if (!open) return;
    void listToday(eventId).then(setRows);
    const id = setInterval(forceTick, 1000);
    return () => clearInterval(id);
  }, [open, eventId]);

  const undoRow = async (row: HistoryEntry) => {
    const result = await undoScan(row.id);
    if (result.ok) setRows(await listToday(eventId));
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent title="Today's scans" description={`${rows.length} on this device · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`} size="md">
        {rows.length === 0 ? (
          <div className="py-8 text-center text-[12.5px] text-neutral-500">Nothing scanned yet today.</div>
        ) : (
          <div className="max-h-[420px] overflow-y-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Student / Team</th>
                  <th>Mode</th>
                  <th>Gate</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap">{formatClock(new Date(row.at))}</td>
                    <td className="truncate">{row.teamName ?? row.userName}</td>
                    <td className="whitespace-nowrap">{row.kind === "meal" ? (row.mealType ?? "meal") : "Entry"}</td>
                    <td className="whitespace-nowrap text-neutral-500">{row.gate ?? gate ?? "—"}</td>
                    <td className="whitespace-nowrap">
                      {row.undone ? (
                        <Tag tone="neutral">Undone</Tag>
                      ) : row.outcome === "ok" ? (
                        <Tag tone="accent">Recorded</Tag>
                      ) : row.outcome === "already-recorded" ? (
                        <Tag tone="outline">Duplicate</Tag>
                      ) : (
                        <Tag tone="neutral">{row.outcome}</Tag>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      {canUndo(row) ? (
                        <button type="button" className="btn btn-ghost text-[12px]" onClick={() => void undoRow(row)}>
                          Undo
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 text-[11px] text-neutral-500">
          A scan can be undone within {UNDO_WINDOW_MS / 1000} seconds of being taken. After that it is part of the record.
        </div>
      </DialogContent>
    </Dialog>
  );
};

/** Dark chrome header used by every scanner state. */
const Shell = ({ title, sub, mode, bare, children }: { title: string; sub: string; mode?: Mode; bare?: boolean; children: React.ReactNode }) => (
  <div className="flex min-h-dvh flex-col bg-bg">
    <div className="bg-neutral-900 px-[18px] pb-3 pt-[calc(10px+env(safe-area-inset-top))]">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[16px] font-medium">{title}</div>
          <div className="truncate text-[11.5px] text-neutral-500">{sub}</div>
        </div>
        {mode ? <Tag tone="outline">{mode === "meal" ? "Meal mode" : "Entry mode"}</Tag> : <Link href="/admin" className="btn btn-ghost text-[12px]">Admin</Link>}
      </div>
    </div>
    {bare ? children : <div className="flex-1">{children}</div>}
  </div>
);
