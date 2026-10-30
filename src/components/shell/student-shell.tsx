"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MagnifyingGlass, Ticket, UsersThree, User as UserIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Brand } from "./brand";
import { UserMenu } from "./user-menu";
import { NotificationBell } from "./notifications";
import { TapBar } from "./tap-bar";

/**
 * The student side.
 *
 * Desktop: the design's top nav (Explore · My events · Teams · Certificates ·
 * account). Phone: the four-item tap bar (Explore · My pass · Teams · Profile).
 * One shell, one breakpoint, so the same page renders both without knowing.
 */

const TOP_LINKS = [
  { href: "/explore", label: "Explore", match: ["/explore", "/f/"] },
  { href: "/my-events", label: "My events", match: ["/my-events", "/my-pass", "/registered"] },
  { href: "/my-registrations", label: "Registrations", match: ["/my-registrations"] },
  { href: "/teams", label: "Teams", match: ["/teams"] },
  { href: "/certificates", label: "Certificates", match: ["/certificates"] },
];

const TAP_LINKS = [
  { href: "/explore", label: "Explore", icon: MagnifyingGlass, match: ["/explore", "/f/"] },
  { href: "/my-pass", label: "My pass", icon: Ticket, match: ["/my-pass", "/my-events", "/my-registrations", "/registered", "/certificates"] },
  { href: "/teams", label: "Teams", icon: UsersThree, match: ["/teams"] },
  { href: "/profile", label: "Profile", icon: UserIcon, match: ["/profile"] },
];

const isActive = (pathname: string, match: string[]) => match.some((m) => pathname === m || pathname.startsWith(m));

export interface StudentShellProps {
  children: React.ReactNode;
  /** Hide the tap bar (e.g. the registration success screen wants full height). */
  hideTapBar?: boolean;
  /** Extra content on the right of the desktop nav, before the account control. */
  navExtra?: React.ReactNode;
  className?: string;
}

/**
 * The desktop header alone, no children prop — a self-contained client
 * component exactly like `PublicNav`/`PublicAuthControls`. Extracted so a
 * Server Component page can render it as a flat sibling instead of wrapping
 * its own (often client) content as `children` of a nav component — see
 * `StudentTapBar` below for why that distinction turned out to matter.
 */
export const StudentNav = ({ navExtra }: { navExtra?: React.ReactNode }) => {
  const pathname = usePathname();
  return (
    <header className="hidden sm:block">
      <nav className="nav mx-auto w-full max-w-[1180px] gap-[26px] px-6 py-4 lg:px-10" aria-label="Primary">
        <Brand href="/" />
        {TOP_LINKS.map((link) => (
          <Link key={link.href} href={link.href} aria-current={isActive(pathname, link.match) ? "page" : undefined}>
            {link.label}
          </Link>
        ))}
        {navExtra}
        <div className="ml-3 flex items-center gap-1.5">
          <NotificationBell />
          <UserMenu variant="student" />
        </div>
      </nav>
    </header>
  );
};

/** The phone tap bar alone, no children prop — the student-side counterpart to `StudentNav`. */
export const StudentTapBar = () => {
  const pathname = usePathname();
  return (
    <TapBar label="Primary" items={TAP_LINKS.map((link) => ({ ...link, active: isActive(pathname, link.match) }))} />
  );
};

/**
 * `/f/[festSlug]` and `/f/[festSlug]/e/[eventSlug]` stopped using this
 * wrapper (see their own files for why — a production-only Server Component
 * render crash on Vercel, never reproduced in `next dev` or `next start`,
 * traced to exactly this component being the one place in the app where a
 * genuine Server Component page passes its own rich, further-client-nested
 * content as `children` of this client nav wrapper). `StudentNav`/
 * `StudentTapBar` above exist so a Server Component page can get the same
 * nav instead, as flat siblings — the same shape `/explore`'s working
 * `PublicNav` already uses. This export is kept, unchanged in behavior, for
 * every other consumer: all of them are reached through
 * `(student)/layout.tsx`, which is itself a Server Component passing
 * children through `RequireRole` into this same wrapper — structurally the
 * same risk, just never isolated or fixed here, because every page behind
 * it requires sign-in and so couldn't be verified against production
 * without credentials this session. If any signed-in student screen is
 * later found to hit the same crash, this is the first place to look.
 */
export const StudentShell = ({ children, hideTapBar, navExtra, className }: StudentShellProps) => {
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col">
      <StudentNav navExtra={navExtra} />

      <main id="main" className={cn("flex-1", !hideTapBar && "pb-[76px] sm:pb-0", className)}>{children}</main>

      {hideTapBar ? null : (
        <TapBar
          label="Primary"
          items={TAP_LINKS.map((link) => ({ ...link, active: isActive(pathname, link.match) }))}
        />
      )}
    </div>
  );
};

/** Consistent page gutter: 18px on a phone (the design's), 40px on desktop. */
export const Page = ({ className, children }: { className?: string; children: React.ReactNode }) => (
  <div className={cn("mx-auto w-full max-w-[1180px] px-[18px] sm:px-6 lg:px-10", className)}>{children}</div>
);
