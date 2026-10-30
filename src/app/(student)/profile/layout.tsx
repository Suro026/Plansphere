import type { Metadata } from "next";

export const metadata: Metadata = { title: "Profile", description: "Your Plansphere account details." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
