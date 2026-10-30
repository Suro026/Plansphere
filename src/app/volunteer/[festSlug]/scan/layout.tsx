import type { Metadata } from "next";

export const metadata: Metadata = { title: "Scanner", description: "Gate and meal scanning." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
