"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/components/providers";
import { Brand } from "@/components/shell/brand";
import { UserMenu } from "@/components/shell/user-menu";
import { Button } from "@/components/ui/button";
import { EmptyState, Kick, MetaList, MetaRow, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import { hasAtLeast } from "@/core/models/user";
import { formatRelative } from "@/lib/utils";

interface Step {
  ok: boolean;
  ms: number;
  detail?: Record<string, unknown>;
  error?: { name: string; message: string };
}
interface Health {
  ok: boolean;
  checkedAt: string;
  checks: Record<string, Step>;
}

const LABELS: Record<string, string> = {
  runtime: "Runtime",
  env: "Environment variables",
  envValidation: "Environment validation",
  serviceAccountParse: "Service account",
  importFirebaseAdmin: "Admin SDK import",
  importServerModule: "Server module",
  adminInit: "Admin SDK init",
  firestoreRead: "Firestore read",
  firestoreIndexes: "Composite indexes",
  storage: "Storage buckets",
  authAdmin: "Auth admin",
  monitoring: "Monitoring & protection",
};

const fmt = (v: unknown): string => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * Health dashboard — the same checks /api/health runs, laid out for a human.
 * Super admins only; the JSON endpoint stays public for uptime monitors.
 */
export default function HealthPage() {
  const { session, status, auth } = useAuth();
  const isSuper = session ? hasAtLeast(session.role, "super_admin") : false;
  const health = useQuery({
    queryKey: ["health"],
    enabled: isSuper,
    refetchInterval: 60_000,
    // Through api() so the ID token goes along: the endpoint only shows
    // messages and facts to a super admin, pass/fail to everyone else.
    queryFn: async (): Promise<Health> => {
      const token = await auth.getIdToken();
      const res = await fetch("/api/health", { cache: "no-store", headers: token ? { authorization: `Bearer ${token}` } : {} });
      return (await res.json()) as Health;
    },
  });

  if (status === "loading") return <div className="mx-auto max-w-[920px] px-6 pt-10"><Skeleton className="h-64" /></div>;
  if (!isSuper) {
    return (
      <div className="mx-auto max-w-[920px] px-6 pt-10">
        <EmptyState title="Super admins only" body="The health dashboard shows infrastructure state for the whole platform." action={<Button asChild variant="secondary"><Link href="/admin">Back to admin</Link></Button>} />
      </div>
    );
  }

  const data = health.data;
  const entries = data ? Object.entries(data.checks) : [];
  const failing = entries.filter(([, s]) => !s.ok);

  return (
    <div className="flex min-h-dvh flex-col">
      <header>
        <nav className="nav mx-auto w-full max-w-[1180px] gap-[26px] px-6 py-4 lg:px-10" aria-label="Primary">
          <Brand href="/" />
          <Link href="/admin/fests">Fests</Link>
          <Link href="/admin/health" aria-current="page">Health</Link>
          <div className="ml-auto">
            <UserMenu variant="admin" />
          </div>
        </nav>
      </header>

      <main id="main" className="mx-auto w-full max-w-[920px] flex-1 px-6 pb-16 pt-6 lg:px-10">
        <PageHeading
          kick="Platform"
          title="Health"
          sub={data ? `Checked ${formatRelative(new Date(data.checkedAt))} · ${entries.length - failing.length}/${entries.length} passing · refreshes every minute` : "Running checks…"}
          actions={
            <Button variant="secondary" onClick={() => void health.refetch()} loading={health.isFetching}>
              Re-run checks
            </Button>
          }
          className="mb-5"
        />

        {health.isPending ? (
          <Skeleton className="h-72" />
        ) : !data ? (
          <EmptyState title="Health endpoint unreachable" body="/api/health did not answer. That is itself the finding — check the Vercel function logs." />
        ) : (
          <>
            <div className="mb-5 flex flex-wrap items-center gap-2">
              {data.ok ? <Tag tone="accent" check>All checks passing</Tag> : <Tag tone="danger">{failing.length} failing</Tag>}
              {data.checks.monitoring?.detail
                ? Object.entries(data.checks.monitoring.detail).map(([k, v]) => (
                    <Tag key={k} tone={String(v).startsWith("off") ? "neutral" : "outline"}>
                      {k}: {fmt(v)}
                    </Tag>
                  ))
                : null}
            </div>

            <div className="flex flex-col gap-4">
              {entries.map(([key, step]) => (
                <section key={key} className={`rounded-md p-[15px] shadow-[var(--shadow-sm)] ${step.ok ? "" : "shadow-[inset_3px_0_0_var(--color-danger)]"}`}>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      {step.ok ? <Tag tone="accent" check>ok</Tag> : <Tag tone="danger">fail</Tag>}
                      <span className="text-[14.5px] font-medium">{LABELS[key] ?? key}</span>
                    </div>
                    <span className="text-[11.5px] text-neutral-500">{step.ms} ms</span>
                  </div>
                  {step.error ? <div className="mb-2 text-[13px] text-danger">{step.error.message}</div> : null}
                  {step.detail ? (
                    <MetaList>
                      {Object.entries(step.detail).map(([k, v]) => (
                        <MetaRow key={k} label={k} mono={typeof v === "string" && /^[A-Za-z0-9._-]+$/.test(v) && v.length > 12}>
                          {Array.isArray(v) ? (v.length ? <span className="text-neutral-300">{v.map(String).join(" · ")}</span> : "none") : fmt(v)}
                        </MetaRow>
                      ))}
                    </MetaList>
                  ) : null}
                </section>
              ))}
            </div>

            <div className="mt-8">
              <Kick className="mb-2">What to do about a failure</Kick>
              <MetaList>
                <MetaRow label="Composite indexes">Run <code className="code">npm run verify:infra</code> and click the console links it prints, or grant the service account Cloud Datastore Index Admin.</MetaRow>
                <MetaRow label="Storage buckets">Supabase dashboard → Storage → New bucket (event-assets, avatars, certificates, uploads), or check <code className="code">SUPABASE_URL</code>/<code className="code">SUPABASE_SERVICE_ROLE_KEY</code> are set.</MetaRow>
                <MetaRow label="Email / Cron / Sentry / App Check">Set the variables named in the warnings on Vercel and redeploy; details in README → Deploy.</MetaRow>
                <MetaRow label="Anything else">The request id in a 500 response matches the <code className="code">[api]</code> log line and the Sentry event.</MetaRow>
              </MetaList>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
