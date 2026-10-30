"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AdminPage, useFest } from "@/components/shell/admin-shell";
import { useAuth, useRepositories } from "@/components/providers";
import { useFestEvents } from "@/components/admin/hooks";
import { useStaff } from "@/components/admin/staff-api";
import { EmailLog } from "@/components/admin/email-log";
import { Button } from "@/components/ui/button";
import { EmptyState, Kick, MetaList, MetaRow, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import type { Event } from "@/core/models/event";
import { AWARD_LABELS } from "@/core/models/result";
import { hasAtLeast } from "@/core/models/user";
import { formatCalendarDate, formatRelative } from "@/lib/utils";

/**
 * 4e — Super admin console. The two things only a super admin does — create
 * admins, create events — and the post-event hand-off: add winners, then
 * push certificates. Everything links into the fuller screens; this is the
 * short path, not a duplicate.
 */
export default function ConsolePage() {
  const { fest, basePath } = useFest();
  const { session, profile } = useAuth();
  const repos = useRepositories();
  const events = useFestEvents(fest.id);
  const staff = useStaff();

  const isSuper = session ? hasAtLeast(session.role, "super_admin") : false;
  const admins = (staff.data ?? []).filter((s) => s.role !== "volunteer" && s.id !== session?.uid);

  const completed = React.useMemo(() => (events.data ?? []).filter((e) => e.status === "completed").sort((a, b) => b.date.localeCompare(a.date)), [events.data]);
  const [focusId, setFocusId] = React.useState<string | null>(null);
  const focus = completed.find((e) => e.id === focusId) ?? completed[0];

  const results = useQuery({
    queryKey: ["result", focus?.id],
    enabled: Boolean(focus),
    queryFn: () => repos.results.getByEvent(focus!.id),
  });
  const attended = useQuery({
    queryKey: ["event-checkins", focus?.id],
    enabled: Boolean(focus),
    queryFn: () => repos.attendance.countByEvent(focus!.id),
  });
  const issued = useQuery({
    queryKey: ["event-cert-count", focus?.id],
    enabled: Boolean(focus),
    queryFn: () => repos.certificates.countByEvent(focus!.id),
  });

  if (!isSuper) {
    return (
      <AdminPage className="pt-[26px]">
        <EmptyState title="Super admins only" body="The console is where admins are created and certificates pushed out." />
      </AdminPage>
    );
  }

  const stage = (e: Event) => {
    if (e.status === "completed") return e.resultsPublishedAt ? <Tag tone="neutral">Results published</Tag> : <Tag tone="accent">Ended · add winners</Tag>;
    if (e.status === "ongoing") return <Tag tone="neutral">Running</Tag>;
    if (e.status === "draft") return <Tag tone="outline">Draft</Tag>;
    return <Tag tone="neutral">Published</Tag>;
  };

  return (
    <AdminPage className="max-w-[820px] pb-8 pt-[26px]">
      <PageHeading
        kick={`${profile?.name ?? session?.email} · super admin`}
        title="Console"
        actions={
          <>
            <Button asChild variant="ghost">
              <Link href="/admin/health">Health</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href={`${basePath}/staff`}>Create admin</Link>
            </Button>
            <Button asChild variant="primary">
              <Link href={`${basePath}/events/new`}>Create event</Link>
            </Button>
          </>
        }
        className="mb-5"
      />

      <Kick className="mb-2.5">Admins</Kick>
      {staff.isPending ? (
        <Skeleton className="h-24" />
      ) : admins.length === 0 ? (
        <div className="text-[12.5px] text-neutral-500">No other admins yet. Create one from Staff — they sign in through the normal login page.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Admin</th>
                <th>Scoped to</th>
                <th>Signs in at</th>
                <th>Last active</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id}>
                  <td>{a.activated ? a.name : a.email}</td>
                  <td>{a.role === "super_admin" || a.festIds.length === 0 ? "All fests" : a.festIds.length === 1 ? fest.name : `${a.festIds.length} fests`}</td>
                  <td>/sign-in</td>
                  <td>{a.lastSignInAt ? formatRelative(new Date(a.lastSignInAt)) : "—"}</td>
                  <td>{a.disabled ? <Tag tone="neutral">Disabled</Tag> : a.activated ? <Tag tone="accent">Active</Tag> : <Tag tone="neutral">Not activated</Tag>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-2.5 text-[12px] text-neutral-500">Admins sign in through the normal login page with the account you created. Only you can grant a role above student.</div>

      <Kick className="mb-2.5 mt-[26px]">Events</Kick>
      {events.loading ? (
        <Skeleton className="h-32" />
      ) : (events.data ?? []).length === 0 ? (
        <div className="text-[12.5px] text-neutral-500">No events yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Date</th>
                <th>Registered</th>
                <th>Stage</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(events.data ?? []).map((e) => (
                <tr key={e.id}>
                  <td>{e.title}</td>
                  <td className="whitespace-nowrap">{formatCalendarDate(e.date)}</td>
                  <td>{e.registeredCount}</td>
                  <td>{stage(e)}</td>
                  <td className="text-right">
                    {e.status === "completed" && !e.resultsPublishedAt ? (
                      <Link href={`${basePath}/events/${e.slug}/results`} className="btn btn-ghost text-[12px]">
                        Add ranks
                      </Link>
                    ) : e.status === "completed" ? (
                      <button type="button" className="btn btn-ghost text-[12px]" onClick={() => setFocusId(e.id)}>
                        Certificates
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {focus ? (
        <div className="mt-[26px] rounded-md p-[17px] shadow-[var(--shadow-sm)]">
          <div className="mb-3.5 flex flex-wrap items-end justify-between gap-2">
            <div>
              <div className="text-[17px] font-medium">After the event · {focus.title}</div>
              <div className="mt-[3px] text-[12.5px] text-neutral-500">Add the winners, then send every remaining certificate by email.</div>
            </div>
            <Tag tone="accent">Step {results.data?.status === "published" ? (issued.data ? 3 : 2) : 1} of 3</Tag>
          </div>

          <div className="mb-4 flex flex-col gap-[9px]">
            {(results.data?.entries ?? []).slice(0, 5).map((entry) => (
              <div key={entry.registrationId} className="flex items-center gap-[11px] rounded-md px-3 py-[11px] shadow-[var(--shadow-sm)]">
                <span className="grid h-6 w-6 flex-none place-items-center rounded-sm text-[12px] text-accent shadow-[inset_0_0_0_1px_var(--color-accent)]">{entry.position}</span>
                <div className="flex-1">
                  <div className="text-[13.5px]">{entry.displayName}</div>
                  <div className="text-[11.5px] text-neutral-500">{AWARD_LABELS[entry.award]} certificate{entry.note ? ` · ${entry.note}` : ""}</div>
                </div>
                <Tag tone="accent">Set</Tag>
              </div>
            ))}
            <Link href={`${basePath}/events/${focus.slug}/results`} className="flex items-center gap-[11px] rounded-md px-3 py-[11px] text-[13px] text-neutral-500 no-underline shadow-[inset_0_0_0_1px_var(--color-divider)] hover:text-text">
              <span className="grid h-6 w-6 flex-none place-items-center rounded-sm shadow-[inset_0_0_0_1px_var(--color-divider)]">+</span>
              {results.data?.entries.length ? "Add a rank or a special mention" : "Add the winners"}
            </Link>
          </div>

          <MetaList>
            <MetaRow label="Results">{results.data?.status === "published" ? `Published ${results.data.publishedAt ? formatRelative(results.data.publishedAt) : ""}` : results.data ? "Draft — not yet published" : "Not started"}</MetaRow>
            <MetaRow label="Checked in">{attended.data ?? "…"} entries eligible for participation certificates</MetaRow>
            <MetaRow label="Certificates issued">{issued.data ?? "…"}</MetaRow>
            <MetaRow label="Sends to">Each participant’s registered email</MetaRow>
            <MetaRow label="Also appears in">Their Plansphere account, instantly</MetaRow>
          </MetaList>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild variant="secondary">
              <Link href={`${basePath}/events/${focus.slug}/results`}>{results.data?.status === "published" ? "Amend results" : "Publish results"}</Link>
            </Button>
            <Button asChild variant="primary">
              <Link href={`${basePath}/certificates`}>{issued.data ? "Certificate center" : "Push certificates"}</Link>
            </Button>
          </div>
          <div className="mt-2.5 text-[12px] text-neutral-500">
            Each email carries the PDF and its public verification link. Failed deliveries are retried and listed in the delivery log — the certificate is already in the student’s account either way.
          </div>
        </div>
      ) : null}

      <EmailLog festId={fest.id} />
    </AdminPage>
  );
}
