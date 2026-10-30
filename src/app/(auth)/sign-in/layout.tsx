import type { Metadata } from "next";

export const metadata: Metadata = { title: "Sign in", description: "Sign in to your Plansphere account." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
