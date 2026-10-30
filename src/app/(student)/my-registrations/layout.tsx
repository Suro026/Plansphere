import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "My registrations",
  description: "Every entry you hold — upcoming, completed, waitlisted and cancelled.",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
