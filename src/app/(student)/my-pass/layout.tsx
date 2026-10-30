import type { Metadata } from "next";

export const metadata: Metadata = { title: "My pass", description: "Your QR ticket \u2014 works offline at the gate." };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
