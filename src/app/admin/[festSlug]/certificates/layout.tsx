import type { Metadata } from "next";

export const metadata: Metadata = { title: "Certificate center", description: "Issue and deliver certificates." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
