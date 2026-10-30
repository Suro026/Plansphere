import type { Metadata } from "next";

export const metadata: Metadata = { title: "Create account", description: "Create a free Plansphere student account to register for fests." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
