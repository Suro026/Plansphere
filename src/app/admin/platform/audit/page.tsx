"use client";

import * as React from "react";
import { AUDIT_ACTIONS, AUDIT_ACTION_LABELS, type AuditAction } from "@/core/models/audit";
import { usePlatformAudit, type AuditFilter } from "@/components/admin/analytics-api";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import { formatCalendarDate, formatClock } from "@/lib/utils";

type FilterMode = "none" | "user" | "action";

/**
 * 8 — Audit Analytics, super-admin only.
 *
 * Reads `/api/admin/platform/audit`, which is the only place this can come
 * from: `auditLog`'s rules let a super admin `list` the whole collection,
 * but filtering by more than one of fest/user/action at once would need a
 * composite index per combination, so the UI mirrors the route's rule of
 * "one filter at a time" rather than offering a combination the backend
 * cannot serve.
 */
export default function PlatformAuditPage() {
  const [mode, setMode] = React.useState<FilterMode>("none");
  const [userId, setUserId] = React.useState("");
  const [action, setAction] = React.useState<AuditAction | "">("");
  const [cursors, setCursors] = React.useState<(string | null)[]>([null]);
  const page = cursors.length - 1;

  const filter: AuditFilter = React.useMemo(() => {
    if (mode === "user" && userId.trim()) return { userId: userId.trim() };
    if (mode === "action" && action) return { action };
    return {};
  }, [mode, userId, action]);

  const audit = usePlatformAudit(filter, cursors[page] ?? null);

  const resetPaging = () => setCursors([null]);

  return (
    <>
      <PageHeading kick="Platform" title="Audit trail" sub="Every privileged action, across every fest." className="mb-5" />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <select
          className="input h-9 w-auto"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as FilterMode);
            resetPaging();
          }}
          aria-label="Filter by"
        >
          <option value="none">No filter</option>
          <option value="user">By user (uid)</option>
          <option value="action">By action type</option>
        </select>
        {mode === "user" ? (
          <input
            className="input h-9 w-[260px]"
            placeholder="User uid"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            onBlur={resetPaging}
            onKeyDown={(e) => e.key === "Enter" && resetPaging()}
          />
        ) : null}
        {mode === "action" ? (
          <select
            className="input h-9 w-auto"
            value={action}
            onChange={(e) => {
              setAction(e.target.value as AuditAction | "");
              resetPaging();
            }}
          >
            <option value="">Choose an action</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {AUDIT_ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {audit.isPending ? (
        <Skeleton className="h-64" />
      ) : audit.isError || !audit.data ? (
        <EmptyState
          title="Couldn't load the audit trail"
          body="Try again in a moment."
          action={
            <Button variant="secondary" onClick={() => audit.refetch()}>
              Try again
            </Button>
          }
        />
      ) : audit.data.entries.length === 0 ? (
        <EmptyState title="No entries" body="Nothing matches this filter yet." />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Summary</th>
                  <th>Actor</th>
                  <th>Fest</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap text-neutral-400">
                      {formatCalendarDate(entry.createdAt.toISOString().slice(0, 10))} · {formatClock(entry.createdAt)}
                    </td>
                    <td className="whitespace-nowrap">
                      <Tag tone="outline">{AUDIT_ACTION_LABELS[entry.action]}</Tag>
                    </td>
                    <td>{entry.summary}</td>
                    <td>
                      {entry.actorName}
                      <div className="text-[11px] text-neutral-500">{entry.actorRole}</div>
                    </td>
                    <td className="font-mono text-[11px] text-neutral-500">{entry.festId ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex justify-between">
            <Button variant="secondary" disabled={page === 0} onClick={() => setCursors((c) => c.slice(0, -1))}>
              Previous
            </Button>
            <Button
              variant="secondary"
              disabled={!audit.data.nextCursor}
              onClick={() => setCursors((c) => [...c, audit.data!.nextCursor])}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </>
  );
}
