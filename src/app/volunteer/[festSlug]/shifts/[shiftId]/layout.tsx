import type { Metadata } from "next";

export const metadata: Metadata = { title: "Shift", description: "Your shift details." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
