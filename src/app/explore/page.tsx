import type { Metadata } from "next";
import { repositories } from "@/data/repositories";
import { PublicFooter, PublicNav } from "@/components/shell/public-nav";
import { ExploreBoard, type FestWithStats } from "@/components/fest/explore-board";

export const metadata: Metadata = {
  alternates: { canonical: "/explore" },
  title: "Explore fests",
  description: "Every published fest, filterable by city, date and category.",
};

export const revalidate = 60;

/** 1b — the board. Many fests at once, filter-first and date-anchored. */
export default async function ExplorePage() {
  const repos = repositories();
  const fests = await repos.fests.listPublished().catch(() => []);

  const withStats: FestWithStats[] = fests.map((fest) => ({
    fest,
    events: fest.stats.events,
    registered: fest.stats.registrations,
  }));

  return (
    <div className="flex min-h-dvh flex-col">
      <PublicNav active="fests" />
      <main id="main" className="flex flex-1 flex-col">
        <ExploreBoard items={withStats} />
      </main>
      <PublicFooter />
    </div>
  );
}
