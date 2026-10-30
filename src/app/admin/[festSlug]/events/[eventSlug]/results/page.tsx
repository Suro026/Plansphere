"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { X } from "@phosphor-icons/react";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { useAdminEvent } from "@/components/admin/event-context";
import { useEventAttendance, useFestRegistrations, useLive } from "@/components/admin/hooks";
import { useAuth, useRepositories } from "@/components/providers";
import { Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent } from "@/components/ui/overlays";
import { EmptyState, Kick, MetaList, MetaRow, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import { AWARD_LABELS, awardForPosition, type Result, type ResultEntry } from "@/core/models/result";
import { parseResultsCsv } from "@/core/services/results-import";
import { RepositoryError } from "@/core/models/common";
import { hasAtLeast } from "@/core/models/user";
import { formatClock, formatRelative } from "@/lib/utils";

interface Row {
  position: number;
  registrationId: string;
  note: string;
}

/**
 * 4d — Publish results. Only checked-in entries can be placed; publishing
 * notifies every participant and unlocks winner certificates. Corrections
 * to a published sheet are saved as amendments, never silent edits.
 */
export default function ResultsPage() {
  const { basePath } = useFest();
  const { event } = useAdminEvent();
  const { session } = useAuth();
  const repos = useRepositories();
  const registrations = useFestRegistrations(event.festId, event.id);
  const attendance = useEventAttendance(event.id);
  const sheet = useLive<Result | null>((onChange, onError) => repos.results.subscribeByEvent(event.id, onChange, onError), [event.id, repos]);

  const isAdmin = session ? hasAtLeast(session.role, "admin") : false;
  const attendedIds = React.useMemo(() => new Set((attendance.data ?? []).map((a) => a.registrationId)), [attendance.data]);
  const eligible = React.useMemo(
    () => (registrations.data ?? []).filter((r) => r.status === "confirmed" && attendedIds.has(r.id)).sort((a, b) => (a.teamName ?? a.userName).localeCompare(b.teamName ?? b.userName)),
    [registrations.data, attendedIds],
  );
  const checkedInAt = React.useCallback((id: string) => attendance.data?.find((a) => a.registrationId === id)?.scannedAt, [attendance.data]);

  const [rows, setRows] = React.useState<Row[]>([
    { position: 1, registrationId: "", note: "" },
    { position: 2, registrationId: "", note: "" },
    { position: 3, registrationId: "", note: "" },
  ]);
  const [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState<"save" | "publish" | "unpublish" | null>(null);
  const [confirmPublish, setConfirmPublish] = React.useState(false);
  const [importErrors, setImportErrors] = React.useState<string[]>([]);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const { rows: imported, errors } = parseResultsCsv(text, eligible);
    setImportErrors(errors);
    if (imported.length > 0) {
      setRows(imported.map((r) => ({ position: r.position, registrationId: r.registrationId, note: r.note })));
      setDirty(true);
      toast.success(`Imported ${imported.length} placing${imported.length === 1 ? "" : "s"}${errors.length ? ` · ${errors.length} row${errors.length === 1 ? "" : "s"} skipped` : ""}`);
    } else {
      toast.error("Nothing in that file matched a checked-in entry.");
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  // Load the saved sheet into the editor once, and again if it changes elsewhere while we are clean.
  React.useEffect(() => {
    if (sheet.data === null && sheet.loading) return;
    if (dirty) return;
    const saved = sheet.data?.entries ?? [];
    if (saved.length) {
      setRows(saved.map((e) => ({ position: e.position, registrationId: e.registrationId, note: e.note ?? "" })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.data?.updatedAt?.getTime(), sheet.loading]);

  const update = (i: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const toEntries = (): ResultEntry[] =>
    rows
      .filter((r) => r.registrationId)
      .map((r) => {
        const reg = eligible.find((e) => e.id === r.registrationId);
        return {
          registrationId: r.registrationId,
          position: r.position,
          award: awardForPosition(r.position),
          displayName: reg ? reg.teamName ?? reg.userName : "—",
          ...(r.note.trim() ? { note: r.note.trim() } : {}),
        };
      });

  const save = async () => {
    setBusy("save");
    try {
      await repos.results.save({ eventId: event.id, entries: toEntries(), status: "draft" });
      setDirty(false);
      toast.success(sheet.data?.status === "published" ? "Amendment saved" : "Draft saved");
    } catch (error) {
      toast.error(error instanceof RepositoryError ? error.message : "Couldn't save");
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    setBusy("publish");
    try {
      if (dirty) await repos.results.save({ eventId: event.id, entries: toEntries(), status: "draft" });
      await repos.results.publish(event.id);
      setDirty(false);
      setConfirmPublish(false);
      toast.success("Results published — participants notified");
    } catch (error) {
      toast.error(error instanceof RepositoryError ? error.message : "Couldn't publish");
    } finally {
      setBusy(null);
    }
  };

  const unpublish = async () => {
    setBusy("unpublish");
    try {
      await repos.results.unpublish(event.id);
      toast.success("Results unpublished");
    } catch (error) {
      toast.error(error instanceof RepositoryError ? error.message : "Couldn't unpublish");
    } finally {
      setBusy(null);
    }
  };

  const placed = rows.filter((r) => r.registrationId);
  const winnerPeople = placed.reduce((s, r) => s + (eligible.find((e) => e.id === r.registrationId)?.members.length ?? 0), 0);
  const participationEntries = Math.max(0, eligible.length - placed.length);
  const published = sheet.data?.status === "published";
  const ended = event.status === "completed";
  const loading = registrations.loading || attendance.loading || sheet.loading;

  return (
    <AdminPage className="max-w-[820px] pb-8 pt-[26px]">
      <PageHeading
        kick={`${event.title}${ended ? " · ended" : ` · ${event.status}`}`}
        title="Publish results"
        sub="Only checked-in teams can be ranked. Publishing notifies every participant and unlocks winner certificates."
        actions={published ? <Tag tone="accent">Published{sheet.data?.amendedAt ? " · amended" : ""}</Tag> : sheet.data ? <Tag tone="neutral">Draft</Tag> : null}
        className="mb-5"
      />

      {!isAdmin ? (
        <EmptyState title="Admins publish results" body="You can see the sheet once it is published. Ask a fest admin to enter the placings." />
      ) : loading ? (
        <Skeleton className="h-64" />
      ) : eligible.length === 0 ? (
        <EmptyState
          title="Nobody has been checked in yet"
          body="Results can only place entries that were scanned at the gate. Once check-ins exist they appear here as candidates."
          action={
            <Button asChild variant="secondary">
              <Link href={`${basePath}/gate`}>Open the gate</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <input ref={fileInput} type="file" accept=".csv,text/csv" className="sr-only" id="results-csv" onChange={(e) => void importCsv(e.target.files?.[0])} />
            <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
              Import CSV
            </Button>
            <span className="text-[12px] text-neutral-500">position, entry (id, ticket code, team or leader name), note — one per line</span>
          </div>
          {importErrors.length > 0 ? (
            <div className="mb-4 rounded-md p-3 text-[12.5px] shadow-[inset_0_0_0_1px_var(--color-danger)]">
              <div className="mb-1.5 text-text">{importErrors.length} row{importErrors.length === 1 ? "" : "s"} skipped</div>
              <ul className="flex flex-col gap-0.5 text-neutral-400">
                {importErrors.slice(0, 10).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mb-5 flex flex-col gap-2.5">
            {rows.map((row, i) => {
              const reg = eligible.find((e) => e.id === row.registrationId);
              const usedElsewhere = new Set(rows.filter((_, j) => j !== i).map((r) => r.registrationId));
              return (
                <div key={i} className="flex flex-wrap items-center gap-[11px] rounded-md p-[13px] shadow-[var(--shadow-sm)] sm:flex-nowrap">
                  <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-sm text-[12px] text-accent shadow-[inset_0_0_0_1px_var(--color-accent)]">{row.position}</span>
                  <div className="min-w-0 flex-1">
                    <select
                      className="input"
                      value={row.registrationId}
                      onChange={(e) => update(i, { registrationId: e.target.value })}
                      aria-label={`Position ${row.position}`}
                    >
                      <option value="">Pick a checked-in entry…</option>
                      {eligible.map((e) => (
                        <option key={e.id} value={e.id} disabled={usedElsewhere.has(e.id)}>
                          {e.teamName ?? e.userName}
                          {e.members.length > 1 ? ` — ${e.members[0]?.name.split(/\s+/)[0]} +${e.members.length - 1}` : ""}
                        </option>
                      ))}
                    </select>
                    {reg ? (
                      <div className="mt-1 text-[11.5px] text-neutral-500">
                        {reg.members.map((m) => m.name).join(", ")} · checked in {formatClock(checkedInAt(reg.id))} · {AWARD_LABELS[awardForPosition(row.position)]}
                      </div>
                    ) : null}
                  </div>
                  <Input className="w-full sm:w-[140px]" placeholder="Prize / note" value={row.note} onChange={(e) => update(i, { note: e.target.value })} aria-label="Prize or note" />
                  {rows.length > 1 ? (
                    <Button variant="secondary" size="icon" aria-label="Remove position" onClick={() => { setRows((rs) => rs.filter((_, j) => j !== i).map((r, j) => ({ ...r, position: j + 1 }))); setDirty(true); }}>
                      <X size={14} />
                    </Button>
                  ) : null}
                </div>
              );
            })}
            <button
              type="button"
              className="flex items-center gap-[11px] rounded-md p-[13px] text-left text-[13px] text-neutral-500 shadow-[inset_0_0_0_1px_var(--color-divider)] hover:text-text"
              onClick={() => { setRows((rs) => [...rs, { position: rs.length + 1, registrationId: "", note: "" }]); setDirty(true); }}
            >
              <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-sm shadow-[inset_0_0_0_1px_var(--color-divider)]">+</span>
              Add a rank or a special mention
            </button>
          </div>

          <MetaList>
            <MetaRow label="Certificates this unlocks">
              {placed.length} winner{placed.length === 1 ? "" : "s"} ({winnerPeople} named) · {participationEntries} participation
            </MetaRow>
            <MetaRow label="Notification">Email + in-app to {eligible.length} checked-in participant{eligible.length === 1 ? "" : "s"}</MetaRow>
            <MetaRow label="Audit">
              {published && sheet.data?.publishedAt ? `Published ${formatRelative(sheet.data.publishedAt)}` : "Published by you, logged with your account"}
              {sheet.data?.amendedAt ? ` · amended ${formatRelative(sheet.data.amendedAt)}` : ""}
            </MetaRow>
            {sheet.data?.certificatesGeneratedAt ? <MetaRow label="Certificates">Generated {formatRelative(sheet.data.certificatesGeneratedAt)} · amendments need a re-run from the Certificate center</MetaRow> : null}
          </MetaList>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={save} loading={busy === "save"} disabled={!dirty}>
              {published ? "Save amendment" : "Save as draft"}
            </Button>
            {published ? (
              <>
                <Button variant="secondary" onClick={unpublish} loading={busy === "unpublish"} disabled={Boolean(sheet.data?.certificatesGeneratedAt)}>
                  Unpublish
                </Button>
                <Button asChild variant="primary">
                  <Link href={`${basePath}/certificates`}>Go to certificates</Link>
                </Button>
              </>
            ) : (
              <AlertDialog open={confirmPublish} onOpenChange={setConfirmPublish}>
                <Button variant="primary" onClick={() => setConfirmPublish(true)} disabled={placed.length === 0}>
                  Publish results
                </Button>
                <AlertDialogContent
                  title="Publish these results?"
                  description={`${placed.length} placing${placed.length === 1 ? "" : "s"} go live and ${eligible.length} participants are notified. You can still amend afterwards; amendments are shown as such.`}
                  confirmLabel="Publish"
                  loading={busy === "publish"}
                  onConfirm={publish}
                />
              </AlertDialog>
            )}
          </div>
          <div className="mt-2.5 text-[12px] text-neutral-500">
            {ended ? "Published results can be corrected, and a correction is shown as an amendment rather than a silent edit." : "The event hasn't been marked completed yet. You can prepare the sheet now and publish when it ends."}
          </div>
          <div className="mt-6">
            <Kick className="mb-1.5">Not eligible</Kick>
            <div className="text-[12.5px] text-neutral-500">
              {(registrations.data ?? []).filter((r) => r.status === "confirmed" && !attendedIds.has(r.id)).length} confirmed entries were never checked in and cannot be placed or certified.
            </div>
          </div>
        </>
      )}
    </AdminPage>
  );
}
