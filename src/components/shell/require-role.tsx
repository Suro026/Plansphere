"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { hasAtLeast, homeForRole, type UserRole } from "@/core/permissions";
import { useAuth } from "@/components/providers";
import { postAuthDestination } from "@/components/auth/destination";
import { Skeleton } from "@/components/ui/primitives";

/**
 * Client-side route guard.
 *
 * Redirects to sign-in when there is no session, and to the caller's own
 * home when the role is too low. This is convenience, not security: it keeps a
 * student from landing on an admin screen full of permission errors. The data
 * itself is protected by firestore.rules and the API's `requireRole`, which do
 * not care what the URL bar says.
 */

/** Re-exported so existing imports keep working; the matrix owns the mapping. */
export const homeFor = homeForRole;

export interface RequireRoleProps {
  minimum: UserRole;
  /** Where to send an authenticated user who lacks the role. */
  fallback?: string;
  /** Require a verified email, for actions that send mail to the address. */
  verified?: boolean;
  children: React.ReactNode;
}

export const RequireRole = ({ minimum, fallback, verified = false, children }: RequireRoleProps) => {
  const { status, session, profile, ready } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const allowed =
    status === "signed-in" &&
    session !== null &&
    hasAtLeast(session.role, minimum) &&
    !session.mustChangePassword &&
    (!verified || session.emailVerified);

  React.useEffect(() => {
    if (!ready) return;

    if (status === "signed-out") {
      router.replace(`/sign-in?next=${encodeURIComponent(pathname)}`);
      return;
    }

    // A temporary password, an unverified address or an unfinished profile
    // each have one place to go, and it is not this page.
    if (session) {
      const destination = postAuthDestination(session, profile, pathname);
      if (destination !== pathname && (session.mustChangePassword || (session.role === "student" && profile && !profile.profileCompleted))) {
        router.replace(destination);
        return;
      }
    }

    // A signed-in account without the role sees an explicit "no access"
    // screen (below) rather than a silent redirect, unless the caller asked
    // for a fallback — the admin/volunteer roots send students to Explore.
    if (session && !hasAtLeast(session.role, minimum)) {
      if (fallback) router.replace(fallback);
      return;
    }

    if (session && verified && !session.emailVerified) {
      router.replace(`/verify-email?next=${encodeURIComponent(pathname)}`);
    }
  }, [ready, status, session, profile, minimum, verified, fallback, pathname, router]);

  if (ready && session && !hasAtLeast(session.role, minimum) && !fallback) return <AccessDenied />;
  if (!ready || !allowed) return <GuardSkeleton />;

  return <>{children}</>;
};

/** The 403 page for a signed-in account whose role is too low. */
export const AccessDenied = () => (
  <div className="mx-auto w-full max-w-[720px] px-5 py-16 sm:px-10">
    <div className="kick mb-2">403</div>
    <h1 className="mb-3 text-[32px] font-medium leading-[1.05] tracking-[-0.03em]">You don’t have access to this</h1>
    <p className="mb-6 max-w-[48ch] text-[15px] text-neutral-300">
      This area is for a role your account doesn’t hold. If you were expecting access, ask the fest’s admin to add you.
    </p>
    <a href="/explore" className="btn btn-primary">
      Back to Explore
    </a>
  </div>
);

/** A quiet placeholder while the session resolves — no spinner, no flash. */
export const GuardSkeleton = () => (
  <div className="mx-auto w-full max-w-[1180px] px-5 py-8 sm:px-10" aria-busy>
    <Skeleton className="mb-4 h-3 w-24" />
    <Skeleton className="mb-6 h-8 w-64" />
    <div className="grid gap-4 sm:grid-cols-3">
      <Skeleton className="h-28" />
      <Skeleton className="h-28" />
      <Skeleton className="h-28" />
    </div>
  </div>
);
