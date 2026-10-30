import * as React from "react";
import type { Metadata } from "next";
import { GuardSkeleton, RequireRole } from "@/components/shell/require-role";

/** The scanner side: volunteers and above. Students are sent back to /explore. */
export const metadata: Metadata = {
  // A nested template so route titles keep the brand suffix (a template only
  // applies to the segment directly below the layout that defines it).
  title: { default: "Volunteer", template: "%s · Plansphere" },
  description: "Your shifts and the scanner.",
  robots: { index: false, follow: false },
};

export default function VolunteerRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireRole minimum="volunteer" fallback="/explore">
      <React.Suspense fallback={<GuardSkeleton />}>{children}</React.Suspense>
    </RequireRole>
  );
}
