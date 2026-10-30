"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/providers";
import { useManagedFests } from "@/components/shell/admin-shell";
import { Brand } from "@/components/shell/brand";
import { UserMenu } from "@/components/shell/user-menu";
import { Button } from "@/components/ui/button";
import { EmptyState, PageHeading, Skeleton, Tag } from "@/components/ui/primitives";
import { hasAtLeast } from "@/core/models/user";
import { formatCount, formatDateRange } from "@/lib/utils";

/**
 * All fests — the super admin's landing when there is more than one. Each
 * row opens that fest's admin. Not in the canvas (it draws one fest at a
 * time); kept to the same table vocabulary.
 */
export default function FestsPage() {
  const { session } = useAuth();
  const router = useRouter();
  const fests = useManagedFests();

  // The list moved into the platform section, where the owner-only verbs
  // (archive, transfer, delete, registration fields) live beside it. This
  // route stays for the links already in the wild.
  React.useEffect(() => {
    if (!session) return;
    router.replace(hasAtLeast(session.role, "super_admin") ? "/admin/platform/fests" : "/admin");
  }, [session, router]);

  const today = new Date().toISOString().slice(0, 10);
  const rows = (fests.data ?? []).slice().sort((a, b) => b.startDate.localeCompare(a.startDate));

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-divider">
        <nav className="nav mx-auto w-full max-w-[1180px] px-5 py-3.5 lg:px-8" aria-label="Admin">
          <Brand href="/admin/fests" role="SUPER ADMIN" />
          <UserMenu variant="admin" />
        </nav>
      </header>
      <main id="main" className="mx-auto w-full max-w-[1180px] flex-1 px-5 pb-9 pt-[26px] lg:px-8">
        <PageHeading
          title="Fests"
          sub={`${rows.length} on the platform`}
          actions={
            <Button asChild variant="primary">
              <Link href="/admin/fests/new">Create a fest</Link>
            </Button>
          }
          className="mb-5"
        />
        {fests.isPending ? (
          <Skeleton className="h-48" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No fests yet"
            body="Create the first one — name, dates, venue — then add events and staff to it."
            action={
              <Button asChild variant="primary">
                <Link href="/admin/fests/new">Create a fest</Link>
              </Button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Fest</th>
                  <th>Dates</th>
                  <th>Events</th>
                  <th>Registrations</th>
                  <th>Check-ins</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => {
                  const live = f.status === "published" && f.startDate <= today && f.endDate >= today;
                  return (
                    <tr key={f.id}>
                      <td>
                        <Link href={`/admin/${f.slug}/overview`} className="text-inherit no-underline hover:text-accent">
                          {f.name}
                        </Link>
                        <div className="text-[11.5px] text-neutral-500">
                          {f.organizationName} · {f.city}
                        </div>
                      </td>
                      <td className="whitespace-nowrap">{formatDateRange(f.startDate, f.endDate)}</td>
                      <td>{formatCount(f.stats.events)}</td>
                      <td>{formatCount(f.stats.registrations)}</td>
                      <td>{formatCount(f.stats.checkIns)}</td>
                      <td>{live ? <Tag tone="accent">Live</Tag> : f.status === "published" ? <Tag tone="neutral">Published</Tag> : f.status === "draft" ? <Tag tone="outline">Draft</Tag> : <Tag tone="neutral">Archived</Tag>}</td>
                      <td className="whitespace-nowrap text-right">
                        <Link href={`/admin/${f.slug}/overview`} className="btn btn-ghost text-[12px]">
                          Open
                        </Link>
                        <Link href={`/admin/${f.slug}/settings`} className="btn btn-ghost text-[12px]">
                          Settings
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
