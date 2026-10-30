import type { Metadata } from "next";

export const metadata: Metadata = { title: "Reset password", description: "Get a link to choose a new Plansphere password." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
