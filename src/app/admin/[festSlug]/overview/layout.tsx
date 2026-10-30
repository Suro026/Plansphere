import type { Metadata } from "next";

export const metadata: Metadata = { title: "Overview", description: "Live figures for the fest." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
