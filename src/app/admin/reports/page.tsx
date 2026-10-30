"use client";

import * as React from "react";
import { hasAtLeast } from "@/core/models/user";
import { useAuth } from "@/components/providers";
import { useManagedFests } from "@/components/shell/admin-shell";
import { downloadAnalyticsExport } from "@/components/admin/analytics-api";
import { Brand } from "@/components/shell/brand";
import { UserMenu } from "@/components/shell/user-menu";
import { Button } from "@/components/ui/button";
import { EmptyState, Kick, PageHeading, Panel, Skeleton } from "@/components/ui/primitives";

type Range = "7" | "30" | "90" | "all";
const RANGE_DAYS: Record<Range, number | null> = { "7": 7, "30": 30, "90": 90, all: null };

/**
 * 6 — Export Center: pick a scope, a range and a format, get a file.
 *
 * A standalone page rather than a tab on one fest's analytics, because a
 * super admin's natural first choice here is "which fest — or the whole
 * platform", and that choice belongs above any one fest's shell.
 */
export default function ReportsPage() {
  const { session } = useAuth();
  const managed = useManagedFests();
  const isSuperAdmin = session ? hasAtLeast(session.role, "super_admin") : false;

  const [scope, setScope] = React.useState<"fest" | "platform">("fest");
  const [festId, setFestId] = React.useState<string>("");
  const [range, setRange] = React.useState<Range>("30");
  const [busy, setBusy] = React.useState<"csv" | "xlsx" | "pdf" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!festId && managed.data && managed.data[0]) setFestId(managed.data[0].id);
  }, [managed.data, festId]);

  const runExport = async (format: "csv" | "xlsx" | "pdf") => {
    setError(null);
    setBusy(format);
    try {
      const days = RANGE_DAYS[range];
      const now = new Date();
      const from = days ? new Date(now.getTime() - days * 24 * 60 * 60 * 1000) : undefined;
      await downloadAnalyticsExport({ scope, festId: scope === "fest" ? festId : undefined, from, to: days ? now : undefined, format });
    } catch {
      setError("Couldn't build that export — try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-divider">
        <nav className="nav mx-auto w-full max-w-[1180px] px-5 py-3.5 lg:px-8" aria-label="Reports">
          <Brand href="/admin" role={isSuperAdmin ? "SUPER ADMIN" : "ADMIN"} />
          <UserMenu variant="admin" />
        </nav>
      </header>
      <main id="main" className="mx-auto w-full max-w-[720px] flex-1 px-5 py-10">
        <PageHeading kick="Reports" title="Export center" sub="A KPI summary, generated server-side, in the format you need." className="mb-6" />

        {managed.isPending ? (
          <Skeleton className="h-48" />
        ) : (
          <Panel className="p-6">
            <Kick className="mb-3">Scope</Kick>
            <div className="mb-5 flex gap-2">
              <Button variant={scope === "fest" ? "primary" : "secondary"} onClick={() => setScope("fest")}>
                One fest
              </Button>
              {isSuperAdmin ? (
                <Button variant={scope === "platform" ? "primary" : "secondary"} onClick={() => setScope("platform")}>
                  Whole platform
                </Button>
              ) : null}
            </div>

            {scope === "fest" ? (
              !managed.data || managed.data.length === 0 ? (
                <EmptyState title="No fest assigned" body="Your account isn't scoped to any fest yet." />
              ) : (
                <>
                  <Kick className="mb-2">Fest</Kick>
                  <select className="input mb-5 h-10 w-full" value={festId} onChange={(e) => setFestId(e.target.value)}>
                    {managed.data.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </>
              )
            ) : null}

            <Kick className="mb-2">Date range</Kick>
            <div className="mb-6 flex gap-2">
              {(["7", "30", "90", "all"] as const).map((r) => (
                <Button key={r} variant={range === r ? "primary" : "secondary"} onClick={() => setRange(r)}>
                  {r === "all" ? "All time" : `${r}d`}
                </Button>
              ))}
            </div>

            <Kick className="mb-2">Format</Kick>
            <div className="flex gap-2">
              {(["csv", "xlsx", "pdf"] as const).map((fmt) => (
                <Button
                  key={fmt}
                  variant="secondary"
                  disabled={busy !== null || (scope === "fest" && !festId)}
                  onClick={() => void runExport(fmt)}
                >
                  {busy === fmt ? "Preparing…" : fmt.toUpperCase()}
                </Button>
              ))}
            </div>
            {error ? <div className="mt-4 text-[12.5px] text-danger">{error}</div> : null}
          </Panel>
        )}
      </main>
    </div>
  );
}
