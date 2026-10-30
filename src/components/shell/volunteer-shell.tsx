"use client";

import * as React from "react";
import { useMemberFests } from "@/components/admin/members-api";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ListChecks, QrCode, Trophy, UsersThree, User as UserIcon } from "@phosphor-icons/react";
import type { Fest } from "@/core/models/fest";
import { useAuth, useRepositories } from "@/components/providers";
import { EmptyState, Skeleton, Tag } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Brand } from "./brand";
import { UserMenu } from "./user-menu";
import { TapBar } from "./tap-bar";
import { cn } from "@/lib/utils";

/* ───────────── fest context ───────────── */

interface VolunteerFestValue {
  fest: Fest;
  basePath: string;
}

const Ctx = React.createContext<VolunteerFestValue | null>(null);

export const useVolunteerFest = (): VolunteerFestValue => {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useVolunteerFest must be used inside /volunteer/[festSlug]");
  return v;
};

/** Fests this account is scoped to. Admins see all; organizers their list. */
export const useVolunteerFests = () => {
  const { session } = useAuth();
  const repos = useRepositories();
  const memberFests = useMemberFests();
  return useQuery({
    queryKey: ["volunteer-fests", session?.uid, session?.festIds, memberFests.ids],
    enabled: Boolean(session),
    queryFn: async () => {
      if (!session) return [];
      if (session.role === "super_admin") return (await repos.fests.list({ limit: 200 })).items;
      // A volunteer with no fest assigned works at none; only the platform lists every fest.
      // Legacy fest-wide scope plus the fests the account holds an event role on.
      const ids = Array.from(new Set([...session.festIds, ...memberFests.ids]));
      if (ids.length === 0) return [];
      return (await repos.fests.list({ festIds: ids, limit: 200 })).items;
    },
  });
};

export const VolunteerFestProvider = ({ festSlug, children }: { festSlug: string; children: React.ReactNode }) => {
  const fests = useVolunteerFests();
  if (fests.isPending) {
    return (
      <div className="px-[18px] py-6" aria-busy>
        <Skeleton className="mb-4 h-6 w-40" />
        <Skeleton className="h-48" />
      </div>
    );
  }
  const fest = (fests.data ?? []).find((f) => f.slug === festSlug);
  if (!fest) {
    return (
      <div className="mx-auto max-w-[560px] px-[18px] py-12">
        <EmptyState
          title="You’re not rostered for this fest"
          body="Ask the admin who created your account to add you to the fest, or pick one you are on."
          action={
            <Button asChild variant="secondary">
              <Link href="/volunteer">My fests</Link>
            </Button>
          }
        />
      </div>
    );
  }
  return <Ctx.Provider value={{ fest, basePath: `/volunteer/${fest.slug}` }}>{children}</Ctx.Provider>;
};

/* ───────────── shell ───────────── */

export const VolunteerShell = ({ children, hideTapBar }: { children: React.ReactNode; hideTapBar?: boolean }) => {
  const { fest, basePath } = useVolunteerFest();
  const pathname = usePathname();

  const links = [
    { href: basePath, label: "My shifts", tap: "Shifts", icon: ListChecks, match: (p: string) => p === basePath || p.startsWith(`${basePath}/shifts`) },
    { href: `${basePath}/scan`, label: "Scanner", tap: "Scan", icon: QrCode, match: (p: string) => p.startsWith(`${basePath}/scan`) },
    { href: `${basePath}/live`, label: "Live", tap: "Live", icon: Trophy, match: (p: string) => p.startsWith(`${basePath}/live`) },
    { href: `${basePath}/team`, label: "Team", tap: "Team", icon: UsersThree, match: (p: string) => p.startsWith(`${basePath}/team`) },
  ];

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="hidden border-b border-divider sm:block">
        <nav className="nav mx-auto w-full max-w-[1180px] gap-[22px] px-6 py-3.5 lg:px-8" aria-label="Volunteer">
          <Brand href={basePath} role="VOLUNTEER" />
          {links.map((l) => (
            <Link key={l.href} href={l.href} aria-current={l.match(pathname) ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
          <div className="ml-3 flex items-center gap-[9px]">
            <Tag tone="neutral">{fest.name}</Tag>
            <UserMenu variant="admin" />
          </div>
        </nav>
      </header>

      <main id="main" className={cn("flex-1", !hideTapBar && "pb-[76px] sm:pb-0")}>{children}</main>

      {hideTapBar ? null : (
        <TapBar
          label="Volunteer"
          items={[
            ...links.map((l) => ({ href: l.href, label: l.tap, icon: l.icon, active: l.match(pathname) })),
            { href: "/profile", label: "Profile", icon: UserIcon, active: pathname === "/profile" },
          ]}
        />
      )}
    </div>
  );
};
