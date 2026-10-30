import type { Metadata } from "next";

export const metadata: Metadata = { title: "Registrations", description: "Every entry for the fest." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
