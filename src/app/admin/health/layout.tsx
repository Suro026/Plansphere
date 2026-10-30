import type { Metadata } from "next";

export const metadata: Metadata = { title: "Health", description: "Platform infrastructure checks." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
