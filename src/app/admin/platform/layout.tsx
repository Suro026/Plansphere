import type { Metadata } from "next";
import { PlatformShell } from "@/components/shell/platform-shell";

export const metadata: Metadata = {
  title: { default: "Platform", template: "%s · Plansphere" },
  description: "Every fest, admin and certificate on the platform.",
  robots: { index: false, follow: false },
};

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}
