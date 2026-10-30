import type { Metadata } from "next";

const title = "Live scores";
const description = "Live scores, brackets and results for every ongoing tournament and event on Plansphere.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/live" },
  openGraph: { type: "website", title, description },
  twitter: { card: "summary", title, description },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
