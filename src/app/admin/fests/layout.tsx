import type { Metadata } from "next";

export const metadata: Metadata = { title: "Fests", description: "The fests you manage." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
