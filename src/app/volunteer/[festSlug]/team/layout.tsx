import type { Metadata } from "next";

export const metadata: Metadata = { title: "Team", description: "Who is on today." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
