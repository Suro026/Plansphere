import type { Metadata } from "next";

export const metadata: Metadata = { title: "Event settings", description: "Edit the event." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
