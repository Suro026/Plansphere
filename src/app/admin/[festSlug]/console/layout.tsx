import type { Metadata } from "next";

export const metadata: Metadata = { title: "Console", description: "Super-admin console." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
