import type { Metadata } from "next";

export const metadata: Metadata = { title: "Gate", description: "Live check-in feed." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
