import type { Metadata } from "next";

export const metadata: Metadata = { title: "Event analytics", description: "Registrations and check-ins over time." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
