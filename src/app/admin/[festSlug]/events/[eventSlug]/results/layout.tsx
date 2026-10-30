import type { Metadata } from "next";

export const metadata: Metadata = { title: "Results", description: "Publish the event's results." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
