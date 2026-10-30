import type { Metadata } from "next";

export const metadata: Metadata = { title: "New fest", description: "Create a fest." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
