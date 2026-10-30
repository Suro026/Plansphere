import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { repositories } from "@/data/repositories";
import { absoluteUrl } from "@/lib/site";
import { StudentNav, StudentTapBar, Page } from "@/components/shell/student-shell";
import { EventLineup, PassCta } from "@/components/event/event-lineup";
import { festPhase } from "@/components/fest/fest-card";
import { Artwork, Kick, Kpi, KpiStrip, Tag } from "@/components/ui/primitives";
import { formatCount, formatDateRange } from "@/lib/utils";

export const revalidate = 60;

type Params = { festSlug: string };

/**
 * `generateMetadata` and the page both need the fest; `cache` makes that one
 * Firestore read per request instead of two (React dedupes it within a render).
 */
const getFest = cache((slug: string) => repositories().fests.getBySlug(slug).catch(() => null));

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { festSlug } = await params;
  const fest = await getFest(festSlug);
  if (!fest) return { title: "Fest not found" };
  const description = fest.tagline ?? `${fest.organizationName} · ${formatDateRange(fest.startDate, fest.endDate)}`;
  return {
    title: fest.name,
    description,
    alternates: { canonical: absoluteUrl(`/f/${fest.slug}`) },
    openGraph: { type: "website", url: absoluteUrl(`/f/${fest.slug}`), title: fest.name, description, images: fest.socialImageUrl ?? fest.bannerUrl ? [{ url: (fest.socialImageUrl ?? fest.bannerUrl)!, alt: `${fest.name} banner` }] : undefined },
    twitter: { card: "summary_large_image", title: fest.name, description },
  };
}

/**
 * 1a — Marquee. One fest at a time, poster-forward. The design's phone frame
 * puts a 392px cover card up top; the web frame puts a 92px headline beside
 * the photograph. Both come from this one page.
 */
export default async function FestPage({ params }: { params: Promise<Params> }) {
  const { festSlug } = await params;
  const repos = repositories();

  const fest = await getFest(festSlug);
  if (!fest || fest.status !== "published") notFound();

  const eventsPage = await repos.events.list({
    festId: fest.id,
    status: ["published", "ongoing", "completed"],
    limit: 200,
  });
  const registered = fest.stats.registrations;
  const checkedIn = fest.stats.checkIns;

  const events = eventsPage.items;
  const phase = festPhase(fest);
  const today = new Date().toISOString().slice(0, 10);
  const dayIndex = Math.max(1, Math.round((new Date(today).getTime() - new Date(fest.startDate).getTime()) / 86400000) + 1);
  const dayCount = Math.max(1, Math.round((new Date(fest.endDate).getTime() - new Date(fest.startDate).getTime()) / 86400000) + 1);

  return (
    <div className="flex min-h-dvh flex-col">
      <StudentNav />
      <main id="main" className="flex-1 pb-[76px] sm:pb-0">
      {/* ── Phone hero: the cover card ── */}
      <div className="sm:hidden">
        <div className="flex items-center justify-between px-5 pb-3 pt-2">
          <div>
            <Kick>{fest.city}</Kick>
            <div className="text-[19px] font-medium tracking-[-0.02em]">{fest.organizationName}</div>
          </div>
        </div>
        <div className="relative mx-5 h-[392px] overflow-hidden rounded-lg">
          <Artwork src={fest.heroUrl ?? fest.bannerUrl} label="fest cover — 1080×1350" className="absolute inset-0 items-start" alt="" />
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to top, var(--color-bg) 4%, color-mix(in srgb, var(--color-bg) 72%, transparent) 38%, transparent 72%)",
            }}
          />
          <div className="absolute left-3 top-3 flex gap-1.5">
            {phase.live ? <Tag tone="live">LIVE NOW</Tag> : <Tag tone="accent">{phase.label}</Tag>}
            {phase.live ? <Tag tone="neutral">Day {Math.min(dayIndex, dayCount)} of {dayCount}</Tag> : null}
          </div>
          <div className="absolute inset-x-4 bottom-3.5">
            <div className="mb-1.5 text-[11px] uppercase tracking-[0.08em] text-accent-300">
              {fest.organizationName} · {fest.venue}
            </div>
            <div className="mb-2 text-[40px] font-semibold leading-[0.98] tracking-[-0.035em]">{fest.name}</div>
            <div className="mb-3.5 text-[12.5px] text-neutral-300">
              {events.length} events · {formatDateRange(fest.startDate, fest.endDate)} · {formatCount(registered)} registered
            </div>
            <a href="#lineup" className="btn btn-fill btn-block py-[11px] text-[14.5px]">
              Explore lineup
            </a>
          </div>
        </div>
      </div>

      {/* ── Desktop hero ── */}
      <Page className="hidden sm:block">
        <div className="grid items-end gap-12 py-[34px] lg:grid-cols-[1.15fr_.85fr]">
          <div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {phase.live ? <Tag tone="live">LIVE NOW</Tag> : <Tag tone="accent">{phase.label}</Tag>}
              {phase.live ? <Tag tone="neutral">Day {Math.min(dayIndex, dayCount)} of {dayCount}</Tag> : (
                <Tag tone="neutral">{formatDateRange(fest.startDate, fest.endDate)}</Tag>
              )}
              <span className="text-[12px] text-neutral-500">{fest.venue}, {fest.city}</span>
            </div>
            <div className="mb-3 text-[13px] uppercase tracking-[0.1em] text-accent-300">{fest.organizationName}</div>
            <h1 className="mb-[18px] text-[64px] font-semibold leading-[0.92] tracking-[-0.04em] lg:text-[92px]">{fest.name}</h1>
            <p className="mb-6 max-w-[520px] text-[16px] text-neutral-300">
              {fest.description ??
                fest.tagline ??
                `${dayCount} ${dayCount === 1 ? "day" : "days"}, ${events.length} events, one pass. Register once and every ticket, meal slot and certificate lives in one place.`}
            </p>
            <PassCta festSlug={fest.slug} eventCount={events.length} />
          </div>
          <Artwork src={fest.heroUrl ?? fest.bannerUrl} label="fest cover photograph — dark background, .lighten" className="h-[340px] rounded-lg" alt="" />
        </div>
      </Page>

      {/* ── Stat band ── */}
      <KpiStrip className="mx-auto mt-5 w-full max-w-[1180px] sm:mt-0">
        <Kpi value={formatCount(registered)} label="Registered" />
        <Kpi value={formatCount(checkedIn)} label={phase.live ? "Checked in" : "Check-ins"} />
        <Kpi value={events.length} label="Events" />
        <Kpi value={dayCount} label={dayCount === 1 ? "Day" : "Days"} />
      </KpiStrip>

      {/* ── Lineup ── */}
      <Page className="pb-10 pt-[30px] sm:pr-6 lg:pr-10 pr-0">
        <EventLineup events={events} festSlug={fest.slug} />
      </Page>
      </main>
      <StudentTapBar />
    </div>
  );
}
