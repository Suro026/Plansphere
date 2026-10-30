import type { Metadata } from "next";

export const metadata: Metadata = { title: "New event", description: "Create an event." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
