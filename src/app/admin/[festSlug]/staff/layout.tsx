import type { Metadata } from "next";

export const metadata: Metadata = { title: "Staff", description: "Admins and organizers for the fest." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
