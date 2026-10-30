import * as React from "react";
import type { Metadata } from "next";
import { GuardSkeleton, RequireRole } from "@/components/shell/require-role";

/**
 * /super — the spec's URL for the super-admin-only analytics and audit
 * pages. The real pages live under `/admin/platform`, alongside every other
 * platform-owner screen; these are redirects, not a second implementation,
 * for the same reason `/volunteer/scan` redirects into the scanner rather
 * than duplicating it.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function SuperRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireRole minimum="super_admin" fallback="/admin">
      <React.Suspense fallback={<GuardSkeleton />}>{children}</React.Suspense>
    </RequireRole>
  );
}
