import type { Metadata } from "next";

export const metadata: Metadata = { title: "Event registrations", description: "Entries for this event." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
