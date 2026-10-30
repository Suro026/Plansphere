import type { Metadata } from "next";
import { repositories } from "@/data/repositories";
import { absoluteUrl } from "@/lib/site";

type Params = { eventId: string };

/**
 * The event id in this route is a Firestore document id, not a slug — the
 * live dashboard is linked to straight from the admin console before an
 * event necessarily has a public slug worth indexing by. Reads the event
 * (and, best-effort, its fest) purely for metadata; the page itself
 * (`page.tsx`, a client component) does its own live data fetching and is
 * unaffected by this file.
 *
 * Titles here spell out "Plansphere" explicitly rather than relying on the
 * root layout's title template: the sibling `../layout.tsx` sets its own
 * plain-string title for `/live`, which resolves against that template and
 * stops it from reaching this deeper segment — a title set here would
 * otherwise render with no site name at all.
 */
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { eventId } = await params;
  const repos = repositories();

  const event = await repos.events.getById(eventId).catch(() => null);
  if (!event) return { title: "Live · Plansphere" };

  const fest = await repos.fests.getById(event.festId).catch(() => null);
  const title = fest ? `${event.title} · ${fest.name} — Live · Plansphere` : `${event.title} — Live · Plansphere`;
  const description = fest
    ? `Live scores, brackets and results for ${event.title} at ${fest.name} on Plansphere.`
    : `Live scores, brackets and results for ${event.title} on Plansphere.`;
  const path = `/live/${eventId}`;

  return {
    title,
    description,
    alternates: { canonical: absoluteUrl(path) },
    openGraph: {
      type: "website",
      url: absoluteUrl(path),
      title,
      description,
      images: event.posterUrl ? [{ url: event.posterUrl, alt: `${event.title} poster` }] : undefined,
    },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
