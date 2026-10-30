import type { Metadata } from "next";

export const metadata: Metadata = { title: "Notifications", description: "Registrations, teams, results, certificates and organizer messages." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
