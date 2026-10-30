import * as React from "react";
import type { Metadata } from "next";
import { GuardSkeleton, RequireRole } from "@/components/shell/require-role";
import { StudentShell } from "@/components/shell/student-shell";

/**
 * Signed-in student pages: My pass, My events, Certificates, Teams, Profile,
 * and the registration success screen. Any signed-in account may use them —
 * staff hold tickets too.
 */
export const metadata: Metadata = {
  // A nested template so route titles keep the brand suffix (a template only
  // applies to the segment directly below the layout that defines it).
  title: { default: "My Plansphere", template: "%s · Plansphere" },
  description: "Your passes, events, teams, certificates and notifications.",
  robots: { index: false, follow: false },
};

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireRole minimum="student">
      <StudentShell>
        <React.Suspense fallback={<GuardSkeleton />}>{children}</React.Suspense>
      </StudentShell>
    </RequireRole>
  );
}
