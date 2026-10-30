import { cache } from "react";
import { repositories } from "@/data/repositories";
import type { Fest } from "@/core/models/fest";
import { EventsSection } from "./sections";

export type FestPhase = "live" | "upcoming" | "ended";

export interface HomeFest {
  fest: Fest;
  phase: FestPhase;
}

const IST = "Asia/Kolkata";
const MAX_SHOWN = 6;

/**
 * What the landing page shows right after the hero: fests that are on right
 * now, then the soonest upcoming ones — public fests only (`listPublished`
 * already applies visibility). If nothing is live or upcoming, the most recent
 * fests are shown, labelled as ended, so the section is never an empty promise.
 * One read per render.
 */
export const getHomeFests = cache(async (): Promise<HomeFest[]> => {
  const published = await repositories().fests.listPublished().catch(() => [] as Fest[]);
  const fests = [...published].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const today = new Date().toLocaleDateString("en-CA", { timeZone: IST });

  const live = fests.filter((f) => f.startDate <= today && f.endDate >= today);
  const upcoming = fests.filter((f) => f.startDate > today);
  const shown: HomeFest[] = [
    ...live.map((fest) => ({ fest, phase: "live" as const })),
    ...upcoming.map((fest) => ({ fest, phase: "upcoming" as const })),
  ].slice(0, MAX_SHOWN);
  if (shown.length) return shown;

  return [...fests]
    .reverse()
    .slice(0, 3)
    .map((fest) => ({ fest, phase: "ended" as const }));
});

export async function HomeEvents() {
  return <EventsSection items={await getHomeFests()} />;
}
