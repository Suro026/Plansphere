import type { Metadata } from "next";

export const metadata: Metadata = { title: "Teams", description: "Your team entries and invitations." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
