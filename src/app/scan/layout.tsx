import type { Metadata } from "next";

export const metadata: Metadata = { title: "Scanner", description: "Gate and meal scanning for staff.", robots: { index: false, follow: false } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
