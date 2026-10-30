import type { Metadata } from "next";

export const metadata: Metadata = { title: "Registration confirmed", description: "Your ticket is ready." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
