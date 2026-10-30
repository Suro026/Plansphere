import type { Metadata } from "next";

export const metadata: Metadata = { title: "Fest settings", description: "Edit the fest." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
