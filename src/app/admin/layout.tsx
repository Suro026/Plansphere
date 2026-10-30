import * as React from "react";
import type { Metadata } from "next";
import { GuardSkeleton, RequireRole } from "@/components/shell/require-role";

/**
 * Everything under /admin needs an admin account — volunteers scan at /scan
 * and have nothing to run here. Which fests an admin may open is decided one
 * level down, by the fest-scoped layout.
 */
export const metadata: Metadata = {
  // A nested template so route titles keep the brand suffix (a template only
  // applies to the segment directly below the layout that defines it).
  title: { default: "Admin", template: "%s · Plansphere" },
  description: "Run your fest: events, registrations, gate, results, certificates and staff.",
  robots: { index: false, follow: false },
};

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireRole minimum="admin" fallback="/explore">
      <React.Suspense fallback={<GuardSkeleton />}>{children}</React.Suspense>
    </RequireRole>
  );
}
