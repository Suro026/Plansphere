import type { MetadataRoute } from "next";
import { repositories } from "@/data/repositories";
import { SITE_URL } from "@/lib/site";

export const revalidate = 3600;

/** Static pages plus every published fest and its public events. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/explore`, lastModified: now, changeFrequency: "hourly", priority: 0.9 },
    { url: `${SITE_URL}/for-colleges`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    { url: `${SITE_URL}/verify`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];

  try {
    const repos = repositories();
    const fests = await repos.fests.listPublished();
    for (const fest of fests) {
      entries.push({ url: `${SITE_URL}/f/${fest.slug}`, lastModified: fest.updatedAt ?? now, changeFrequency: "daily", priority: 0.8 });
      const events = await repos.events
        .list({ festId: fest.id, status: ["published", "ongoing", "completed"], limit: 200 })
        .catch(() => ({ items: [] as Array<{ slug: string; updatedAt?: Date }> }));
      for (const event of events.items) {
        entries.push({ url: `${SITE_URL}/f/${fest.slug}/e/${event.slug}`, lastModified: event.updatedAt ?? now, changeFrequency: "daily", priority: 0.7 });
      }
    }
  } catch {
    // Firebase unavailable at build/revalidate time: the static part still ships.
  }

  return entries;
}
