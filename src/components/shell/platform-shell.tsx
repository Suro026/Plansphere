"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { hasAtLeast } from "@/core/models/user";
import { useAuth } from "@/components/providers";
import { GuardSkeleton } from "@/components/shell/require-role";
import { Brand } from "@/components/shell/brand";
import { UserMenu } from "@/components/shell/user-menu";
import { EmptyState } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";

/**
 * The frame around /admin/platform.
 *
 * Everything under it is the platform owner's: fests across the whole
 * installation, the admins who run them, certificate releases, the account
 * itself. `RequireRole minimum="admin"` one level up already keeps students
 * and volunteers out; this adds the last step, because an admin who manages
 * a fest is not an owner of the platform.
 */

const TABS = [
  { href: "/admin/platform", label: "Overview" },
  { href: "/admin/platform/fests", label: "Fests" },
  { href: "/admin/platform/applications", label: "Applications" },
  { href: "/admin/platform/admins", label: "Admins" },
  { href: "/admin/platform/certificates", label: "Certificates" },
  { href: "/admin/platform/analytics", label: "Analytics" },
  { href: "/admin/platform/audit", label: "Audit" },
  { href: "/admin/platform/profile", label: "Profile" },
] as const;

export const PlatformShell = ({ children }: { children: React.ReactNode }) => {
  const { session } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const allowed = session ? hasAtLeast(session.role, "super_admin") : undefined;

  React.useEffect(() => {
    if (allowed === false) router.replace("/admin");
  }, [allowed, router]);

  if (!session) return <GuardSkeleton />;

  if (!allowed) {
    return (
      <div className="mx-auto w-full max-w-[720px] px-5 py-16">
        <EmptyState
          title="Platform settings are the owner's"
          body="This section covers every fest on the installation, the admin accounts and certificate releases. Your account administers its own fests — everything you need is under Admin."
          action={
            <Button asChild variant="secondary">
              <Link href="/admin">Back to your fests</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-divider">
        <nav
          className="nav mx-auto w-full max-w-[1180px] gap-6 overflow-x-auto scrollbar-none px-5 py-3.5 lg:px-8"
          aria-label="Platform"
        >
          <Brand href="/admin/platform" role="SUPER ADMIN" />
          {TABS.map((tab) => {
            const active = tab.href === "/admin/platform" ? pathname === tab.href : pathname.startsWith(tab.href);
            return (
              <Link key={tab.href} href={tab.href} aria-current={active ? "page" : undefined} className="whitespace-nowrap">
                {tab.label}
              </Link>
            );
          })}
          <div className="ml-3 flex flex-none items-center gap-2.5">
            <Link href="/admin" className="tag tag-neutral no-underline">
              Fest admin
            </Link>
            <UserMenu variant="admin" />
          </div>
        </nav>
      </header>
      <main id="main" className="mx-auto w-full max-w-[1180px] flex-1 px-5 pb-10 pt-6 lg:px-8">
        {children}
      </main>
    </div>
  );
};
