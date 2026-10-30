import type { Metadata } from "next";

export const metadata: Metadata = { title: "My events", description: "Everything you have registered for, upcoming and attended." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
