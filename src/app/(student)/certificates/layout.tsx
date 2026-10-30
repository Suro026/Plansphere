import type { Metadata } from "next";

export const metadata: Metadata = { title: "My certificates", description: "Certificates issued to you, with public verification links." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
