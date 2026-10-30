import type { Metadata } from "next";

export const metadata: Metadata = { title: "Events", description: "The fest's events." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
