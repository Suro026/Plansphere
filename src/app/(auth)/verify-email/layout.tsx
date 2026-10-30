import type { Metadata } from "next";

export const metadata: Metadata = { title: "Verify email", description: "Confirm your email address to finish setting up Plansphere." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
