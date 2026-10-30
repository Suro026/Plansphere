"use client";

import * as React from "react";
import Link from "next/link";
import { usePlatformStats } from "@/components/admin/platform-api";
import { Button } from "@/components/ui/button";
import { AnimatedList, EmptyState, Kpi, KpiStrip, PageHeading, Skeleton, Table, Tag } from "@/components/ui/primitives";
import { FEST_TYPE_LABELS, type FestType } from "@/core/models/fest";
import { formatCount, formatDateRange, formatRelative } from "@/lib/utils";

/**
 * The platform overview.
 *
 * Six numbers and three short tables — what exists, who runs it, what
 * happened last. Anything longer belongs on the page for that thing, which
 * every row links to.
 */
export default function PlatformOverviewPage() {
  const stats = usePlatformStats();

  if (stats.isPending) {
    return (
      <>
        <Skeleton className="mb-5 h-10 w-[280px]" />
        <Skeleton className="mb-6 h-[92px]" />
        <Skeleton className="h-64" />
      </>
    );
  }

  if (stats.isError || !stats.data) {
    return (
      <EmptyState
        title="Couldn't load the platform figures"
        body="The dashboard reads counts straight from Firestore. If this persists, check /admin/health — an index or a permission is the usual cause."
        action={
          <Button variant="secondary" onClick={() => stats.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  const { kpis, recentFests, recentAdmins, recentRegistrations } = stats.data;

  return (
    <>
      <PageHeading
        kick="Platform"
        title="Everything, at a glance"
        sub={`${formatCount(kpis.activeFests)} running today · ${formatCount(kpis.fests)} fest${kpis.fests === 1 ? "" : "s"} in total`}
        actions={
          <>
            <Button asChild variant="secondary">
              <Link href="/admin/platform/admins">Create an admin</Link>
            </Button>
            <Button asChild variant="primary">
              <Link href="/admin/fests/new">Create a fest</Link>
            </Button>
          </>
        }
        className="mb-5"
      />

      <KpiStrip className="mb-7">
        <AnimatedList stagger={35} className="flex">
          <Kpi value={kpis.fests} label="Fests" />
          <Kpi value={kpis.activeFests} label="Active now" />
          <Kpi value={kpis.events} label="Events" />
          <Kpi value={kpis.students} label="Students" />
          <Kpi value={kpis.admins} label="Admins" />
          <Kpi value={kpis.registrations} label="Registrations" />
          <Kpi value={kpis.certificates} label="Certificates" />
        </AnimatedList>
      </KpiStrip>

      <section className="mb-8" aria-labelledby="recent-fests">
        <h2 id="recent-fests" className="mb-3 text-[17px]">
          Recent fests
        </h2>
        {recentFests.length === 0 ? (
          <EmptyState
            title="No fests yet"
            body="A fest is the container everything else hangs off — events, staff, certificates. Create the first one and the rest of this dashboard fills in."
            action={
              <Button asChild variant="primary">
                <Link href="/admin/fests/new">Create a fest</Link>
              </Button>
            }
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Fest</th>
                <th>Kind</th>
                <th>Dates</th>
                <th>Events</th>
                <th>Registrations</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <AnimatedList as="tbody" variant="fade">
              {recentFests.map((fest) => (
                <tr key={fest.id}>
                    <td>
                      <Link href={`/admin/${fest.slug}/overview`} className="text-inherit no-underline hover:text-accent">
                        {fest.name}
                      </Link>
                      <div className="font-mono text-[11px] text-neutral-500">/f/{fest.slug}</div>
                    </td>
                    <td className="whitespace-nowrap text-neutral-400">{FEST_TYPE_LABELS[fest.festType as FestType] ?? "Other"}</td>
                    <td className="whitespace-nowrap">{formatDateRange(fest.startDate, fest.endDate)}</td>
                    <td>{formatCount(fest.stats?.events ?? 0)}</td>
                    <td>{formatCount(fest.stats?.registrations ?? 0)}</td>
                    <td>
                      {fest.status === "published" ? (
                        <Tag tone="accent">Published</Tag>
                      ) : fest.status === "archived" ? (
                        <Tag tone="neutral">Archived</Tag>
                      ) : (
                        <Tag tone="outline">Draft</Tag>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <Link href={`/admin/${fest.slug}/settings`} className="btn btn-ghost text-[12px]">
                        Settings
                      </Link>
                    </td>
                  </tr>
              ))}
            </AnimatedList>
          </Table>
        )}
      </section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section aria-labelledby="recent-admins">
          <h2 id="recent-admins" className="mb-3 text-[17px]">
            Recently created admins
          </h2>
          {recentAdmins.length === 0 ? (
            <EmptyState title="No admins yet" body="Admins are created here, never self-registered. They get an email with a temporary password and set their own on first sign-in." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Fests</th>
                  <th>State</th>
                </tr>
              </thead>
              <AnimatedList as="tbody" variant="fade">
                {recentAdmins.map((admin) => (
                  <tr key={admin.id}>
                    <td>
                      {admin.name || "—"}
                      <div className="truncate text-[11.5px] text-neutral-500">{admin.email}</div>
                    </td>
                    <td className="whitespace-nowrap">{admin.role === "super_admin" ? "Super admin" : "Admin"}</td>
                    <td>{admin.role === "super_admin" ? "All" : formatCount(admin.festIds.length)}</td>
                    <td className="whitespace-nowrap">
                      {admin.disabled ? (
                        <Tag tone="neutral">Disabled</Tag>
                      ) : admin.mustChangePassword ? (
                        <Tag tone="outline">Invited</Tag>
                      ) : (
                        <Tag tone="accent">Active</Tag>
                      )}
                    </td>
                  </tr>
                ))}
              </AnimatedList>
            </Table>
          )}
        </section>

        <section aria-labelledby="recent-registrations">
          <h2 id="recent-registrations" className="mb-3 text-[17px]">
            Latest registrations
          </h2>
          {recentRegistrations.length === 0 ? (
            <EmptyState title="Nothing yet" body="Entries appear here the moment a student confirms one, across every fest." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Event</th>
                  <th>Seats</th>
                  <th>When</th>
                </tr>
              </thead>
              <AnimatedList as="tbody" variant="fade">
                {recentRegistrations.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {row.userName || "—"}
                      <div className="truncate text-[11.5px] text-neutral-500">{row.userEmail}</div>
                    </td>
                    <td>
                      {row.eventTitle}
                      {row.status !== "confirmed" ? <div className="text-[11.5px] text-neutral-500">{row.status}</div> : null}
                    </td>
                    <td>{row.seats}</td>
                    <td className="whitespace-nowrap text-neutral-400">{formatRelative(row.createdAt ? new Date(row.createdAt) : null)}</td>
                  </tr>
                ))}
              </AnimatedList>
            </Table>
          )}
        </section>
      </div>
    </>
  );
}
