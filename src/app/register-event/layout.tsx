import type { Metadata } from "next";

const title = "Create a College Event | Plansphere";
const description =
  "Create your college fest, conference, sports meet or cultural event. Once the Plansphere team verifies it you run it as its Event Super Admin: registrations, QR entry, live scoring and certificates.";

export const metadata: Metadata = {
  // `absolute` opts out of the root layout's "%s · Plansphere" title
  // template — the spec's title already ends in "| Plansphere" and the
  // template would otherwise append a second "· Plansphere" after it.
  title: { absolute: title },
  description,
  alternates: { canonical: "https://plansphere.in/register-event" },
  openGraph: { title, description },
  twitter: { title, description },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
