"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { Fest } from "@/core/models/fest";
import { hasAtLeast } from "@/core/models/user";
import { FEST_ROLE_LABELS, MEMBER_NAV } from "@/core/models/membership";
import type { UserRole } from "@/core/permissions";
import { useMemberFests, useMyAccess } from "@/components/admin/members-api";
import { useAuth, useRepositories } from "@/components/providers";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { EmptyState, Skeleton } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Brand } from "./brand";
import { UserMenu } from "./user-menu";

/* ───────────── fest context ───────────── */

interface FestContextValue {
  fest: Fest;
  /** Every fest this account may manage, for the switcher. */
  fests: Fest[];
  basePath: string;
}

const FestContext = React.createContext<FestContextValue | null>(null);

export const useFest = (): FestContextValue => {
  const value = React.useContext(FestContext);
  if (!value) throw new Error("useFest must be used inside an admin fest route");
  return value;
};

/** The fests the signed-in staff member can administer. */
export const useManagedFests = () => {
  const { session } = useAuth();
  const repos = useRepositories();
  const memberFests = useMemberFests();

  return useQuery({
    queryKey: ["managed-fests", session?.uid, session?.role, session?.festIds, memberFests.ids],
    enabled: Boolean(session),
    queryFn: async () => {
      if (!session) return [];
      if (session.role === "super_admin") {
        // The platform sees everything. Nobody else lists fests: an admin with no fest assigned manages none.
        const page = await repos.fests.list({ limit: 200 });
        return page.items;
      }
      // Legacy fest-wide scope plus the fests the account holds an event role on.
      const ids = Array.from(new Set([...session.festIds, ...memberFests.ids]));
      if (ids.length === 0) return [];
      const page = await repos.fests.list({ festIds: ids, limit: 200 });
      return page.items;
    },
  });
};

/**
 * Resolves `/admin/[festSlug]` and provides the fest to everything beneath.
 * Refuses (with a clear message, not a blank page) when the slug is unknown
 * or the account is not scoped to it.
 */
export const FestProvider = ({ festSlug, children }: { festSlug: string; children: React.ReactNode }) => {
  const managed = useManagedFests();

  if (managed.isPending) {
    return (
      <div className="mx-auto w-full max-w-[1180px] px-6 py-10 lg:px-8" aria-busy>
        <Skeleton className="mb-6 h-9 w-full max-w-[720px]" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const fests = managed.data ?? [];
  const fest = fests.find((f) => f.slug === festSlug);

  if (!fest) {
    return (
      <div className="mx-auto w-full max-w-[720px] px-6 py-16">
        <EmptyState
          title="This fest isn't in your scope"
          body={
            fests.length
              ? "Your account manages other fests. Pick one of them, or ask a super admin to add this one to your scope."
              : "Your account isn't scoped to any fest yet. Ask a super admin to assign one."
          }
          action={
            fests[0] ? (
              <Button asChild variant="primary">
                <Link href={`/admin/${fests[0].slug}/overview`}>Open {fests[0].name}</Link>
              </Button>
            ) : (
              <Button asChild variant="secondary">
                <Link href="/explore">Back to the student side</Link>
              </Button>
            )
          }
        />
      </div>
    );
  }

  return (
    <FestContext.Provider value={{ fest, fests, basePath: `/admin/${fest.slug}` }}>{children}</FestContext.Provider>
  );
};

/* ───────────── shell ───────────── */

const NAV = [
  { seg: "overview", label: "Overview", min: "volunteer" },
  { seg: "events", label: "Events", min: "volunteer" },
  { seg: "registrations", label: "Registrations", min: "volunteer" },
  { seg: "gate", label: "Gate", min: "volunteer" },
  { seg: "arenas", label: "Arenas", min: "admin" },
  { seg: "analytics", label: "Analytics", min: "admin" },
  { seg: "certificates", label: "Certificates", min: "admin" },
  { seg: "volunteers", label: "Volunteers", min: "admin" },
  { seg: "staff", label: "Staff", min: "admin" },
  { seg: "team", label: "Team", min: "admin" },
  { seg: "console", label: "Console", min: "super_admin" },
  { seg: "settings", label: "Settings", min: "admin" },
] as const;

export const AdminShell = ({ children }: { children: React.ReactNode }) => {
  const { fest, fests, basePath } = useFest();
  const { session } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  // An account that holds an event role on this fest is shown what that role allows - read live from the server, not
  // from the token - and the role's name instead of the account's global one. Everyone else keeps the older scheme.
  const memberFests = useMemberFests();
  const governedByMembership = memberFests.ids.includes(fest.id);
  const access = useMyAccess(governedByMembership);
  const membership = access.data?.memberships.find((m) => m.festId === fest.id);
  const sections: readonly string[] | null = governedByMembership ? (membership ? MEMBER_NAV[membership.role] : ["overview"]) : null;

  const visible = (seg: string, min: UserRole): boolean => {
    if (!session) return false;
    return sections ? sections.includes(seg) : hasAtLeast(session.role, min);
  };

  const roleLabel =
    session?.role === "super_admin" ? "SUPER ADMIN" : membership ? FEST_ROLE_LABELS[membership.role].toUpperCase() : session?.role === "admin" ? "ADMIN" : "ORGANIZER";

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-divider">
        <nav
          className="nav mx-auto w-full max-w-[1180px] gap-6 overflow-x-auto scrollbar-none px-5 py-3.5 lg:px-8"
          aria-label="Admin"
        >
          <Brand href={`${basePath}/overview`} role={roleLabel} />
          {NAV.filter((item) => visible(item.seg, item.min)).map((item) => {
            const href = `${basePath}/${item.seg}`;
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link key={item.seg} href={href} aria-current={active ? "page" : undefined} className="whitespace-nowrap">
                {item.label}
              </Link>
            );
          })}
          <div className="ml-3 flex flex-none items-center gap-2.5">
            <Menu>
              <MenuTrigger asChild>
                <button type="button" className="tag tag-neutral cursor-pointer gap-1.5" aria-label="Switch fest">
                  {fest.name} <CaretDown size={10} weight="bold" />
                </button>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuLabel>Your fests</MenuLabel>
                {fests.map((f) => (
                  <MenuItem
                    key={f.id}
                    onSelect={() => {
                      // Keep the same section when switching fests.
                      const rest = pathname.slice(basePath.length) || "/overview";
                      const section = rest.split("/")[1] ?? "overview";
                      router.push(`/admin/${f.slug}/${section}`);
                    }}
                  >
                    <span className="w-3.5">{f.id === fest.id ? <Check size={13} /> : null}</span>
                    {f.name}
                  </MenuItem>
                ))}
                {session && hasAtLeast(session.role, "super_admin") ? (
                  <>
                    <MenuSeparator />
                    <MenuItem asChild>
                      <Link href="/admin/platform">Platform</Link>
                    </MenuItem>
                    <MenuItem asChild>
                      <Link href="/admin/platform/fests">All fests</Link>
                    </MenuItem>
                    <MenuItem asChild>
                      <Link href="/admin/fests/new">Create a fest</Link>
                    </MenuItem>
                  </>
                ) : null}
              </MenuContent>
            </Menu>
            <UserMenu variant="admin" />
          </div>
        </nav>
      </header>
      <main id="main" className="flex-1">{children}</main>
    </div>
  );
};

/** Admin pages use a 32px gutter at desktop, per the canvas. */
export const AdminPage = ({ className, children }: { className?: string; children: React.ReactNode }) => (
  <div className={cn("mx-auto w-full max-w-[1180px] px-5 lg:px-8", className)}>{children}</div>
);
