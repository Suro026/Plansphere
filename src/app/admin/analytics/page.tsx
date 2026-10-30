"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { hasAtLeast } from "@/core/models/user";
import { useAuth } from "@/components/providers";
import { useManagedFests } from "@/components/shell/admin-shell";
import { GuardSkeleton } from "@/components/shell/require-role";

/**
 * /admin/analytics — the spec's URL for "my analytics". An admin has
 * exactly one meaningful destination (their own fest's analytics, or a
 * picker if they run more than one); a super admin's equivalent is the
 * platform-wide page. Same redirect shape as `/admin` itself.
 */
export default function AdminAnalyticsRedirect() {
  const { session } = useAuth();
  const router = useRouter();
  const managed = useManagedFests();

  React.useEffect(() => {
    if (!managed.data || !session) return;
    if (hasAtLeast(session.role, "super_admin")) {
      router.replace("/admin/platform/analytics");
      return;
    }
    const fest = managed.data[0];
    if (fest) router.replace(`/admin/${fest.slug}/analytics`);
    else router.replace("/admin");
  }, [managed.data, session, router]);

  return <GuardSkeleton />;
}
