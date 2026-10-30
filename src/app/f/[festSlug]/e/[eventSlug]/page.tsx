import Team01, { hasTeamProfile } from "@/components/ui/team-01";
import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { repositories } from "@/data/repositories";
import { absoluteUrl } from "@/lib/site";
import type { Fest } from "@/core/models/fest";
import type { Event } from "@/core/models/event";
import { categoryLabel } from "@/core/models/event";
import { StudentNav, StudentTapBar, Page } from "@/components/shell/student-shell";
import { RegisterPanel } from "@/components/event/register-panel";
import { Artwork, Kick, MetaList, MetaRow, Tag } from "@/components/ui/primitives";
import { formatCalendarDate, formatTeamSize } from "@/lib/utils";

export const revalidate = 30;

type Params = { festSlug: string; eventSlug: string };

/**
 * Shared by `generateMetadata` and the page. `cache` (keyed on the two slugs, so the
 * arguments must stay primitives) turns four Firestore reads per request into two.
 */
const load = cache(async (festSlug: string, eventSlug: string) => {
  const repos = repositories();
  const fest = await repos.fests.getBySlug(festSlug).catch(() => null);
  if (!fest || fest.status !== "published") return null;
  const event = await repos.events.getBySlug(fest.id, eventSlug).catch(() => null);
  if (!event || event.status === "draft") return null;
  return { fest, event };
});

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { festSlug, eventSlug } = await params;
  const data = await load(festSlug, eventSlug);
  if (!data) return { title: "Event not found" };
  const path = `/f/${data.fest.slug}/e/${data.event.slug}`;
  const description = data.event.description?.slice(0, 160) || `${data.event.title} at ${data.fest.name} · ${formatCalendarDate(data.event.date)} · ${data.event.venue}`;
  return {
    title: `${data.event.title} · ${data.fest.name}`,
    description,
    alternates: { canonical: absoluteUrl(path) },
    openGraph: {
      type: "website",
      url: absoluteUrl(path),
      title: `${data.event.title} · ${data.fest.name}`,
      description,
      images: data.event.posterUrl ? [{ url: data.event.posterUrl, alt: `${data.event.title} poster` }] : [`/f/${data.fest.slug}/opengraph-image`],
    },
    twitter: { card: "summary_large_image", title: `${data.event.title} · ${data.fest.name}`, description },
  };
}

/** schema.org Event — lets search engines show date, venue and free/paid entry. */
const eventJsonLd = (fest: Fest, event: Event) => ({
  "@context": "https://schema.org",
  "@type": "Event",
  name: event.title,
  description: event.description,
  startDate: `${event.date}T${event.startTime}:00+05:30`,
  ...(event.endTime ? { endDate: `${event.date}T${event.endTime}:00+05:30` } : {}),
  eventStatus: event.status === "cancelled" ? "https://schema.org/EventCancelled" : "https://schema.org/EventScheduled",
  eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
  location: { "@type": "Place", name: event.venue, address: { "@type": "PostalAddress", addressLocality: fest.city, addressCountry: "IN" } },
  image: event.posterUrl ? [event.posterUrl] : [absoluteUrl(`/f/${fest.slug}/opengraph-image`)],
  organizer: { "@type": "Organization", name: fest.organizationName, url: absoluteUrl(`/f/${fest.slug}`) },
  superEvent: { "@type": "Festival", name: fest.name, url: absoluteUrl(`/f/${fest.slug}`) },
  offers: {
    "@type": "Offer",
    url: absoluteUrl(`/f/${fest.slug}/e/${event.slug}`),
    price: event.entryFee,
    priceCurrency: "INR",
    availability: event.capacity > 0 && event.registeredCount >= event.capacity ? "https://schema.org/SoldOut" : "https://schema.org/InStock",
  },
});

/** 2a — event detail. Poster card on a phone, 52px headline with a two-column body on desktop. */
export default async function EventPage({ params }: { params: Promise<Params> }) {
  const { festSlug, eventSlug } = await params;
  const data = await load(festSlug, eventSlug);
  if (!data) notFound();
  const { fest, event } = data;

  const when = `${new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(new Date(`${event.date}T00:00:00`))} ${formatCalendarDate(event.date)} · ${event.startTime}${event.endTime ? ` – ${event.endTime}` : ""}`;

  return (
    <div className="flex min-h-dvh flex-col">
      <StudentNav />
      <main id="main" className="flex-1 pb-[76px] sm:pb-0">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(eventJsonLd(fest, event)) }} />
      <Page className="pb-[150px] pt-1.5 sm:pt-[30px] lg:pb-11">
        <div className="grid gap-11 lg:grid-cols-[1fr_372px]">
          <div>
            {/* Phone: poster card */}
            <div className="relative mb-3.5 h-[250px] overflow-hidden rounded-lg lg:hidden">
              <Artwork src={event.posterUrl} label="event poster" className="absolute inset-0 items-start" alt="" />
              <div className="absolute inset-0" style={{ background: "linear-gradient(to top, var(--color-bg) 6%, transparent 70%)" }} />
              <div className="absolute inset-x-3.5 bottom-3">
                <div className="mb-2 flex gap-1.5">
                  <Tag tone="accent">{categoryLabel(event.category)}</Tag>
                  <Tag tone="neutral">{formatTeamSize(event.eventType, event.teamSize)}</Tag>
                </div>
                <div className="text-[27px] font-medium leading-[1.05] tracking-[-0.025em]">{event.title}</div>
              </div>
            </div>

            {/* Desktop: heading */}
            <div className="hidden lg:block">
              <div className="mb-3.5 flex flex-wrap items-center gap-2">
                <Tag tone="accent">{categoryLabel(event.category)}</Tag>
                <Tag tone="neutral">{formatTeamSize(event.eventType, event.teamSize)}</Tag>
                <Link href={`/f/${fest.slug}`} className="text-[12px] text-neutral-500 no-underline hover:text-accent">
                  {fest.name} · {fest.organizationName}
                </Link>
              </div>
              <h1 className="mb-3.5 text-[52px] leading-none tracking-[-0.03em]">{event.title}</h1>
              {event.description ? <p className="max-w-[560px] text-[15.5px] text-neutral-300">{event.description}</p> : null}
              <Artwork src={event.posterUrl} label="event photograph — dark background, .lighten" className="my-6 h-[280px] rounded-lg" alt="" />
            </div>

            {/* Phone: meta */}
            <MetaList className="lg:hidden">
              <MetaRow label="When">{when}</MetaRow>
              <MetaRow label="Where">{event.venue}</MetaRow>
              {event.capacity > 0 ? (
                <MetaRow label="Seats">
                  {event.registeredCount} of {event.capacity} taken
                </MetaRow>
              ) : null}
              {event.registrationDeadline ? <MetaRow label="Registration closes">{formatCalendarDate(event.registrationDeadline)}, 23:59</MetaRow> : null}
            </MetaList>

            {event.description ? <p className="mt-4 text-[13.5px] text-neutral-300 lg:hidden">{event.description}</p> : null}

            {/* Details */}
            <div className="mt-6 grid gap-8 border-t border-divider pt-6 sm:grid-cols-2 lg:mt-8 lg:pt-8">
              {event.prizes.length ? (
                <div className="sm:col-span-2 lg:col-span-1">
                  <Kick className="mb-2">Prizes</Kick>
                  <div className="flex flex-col gap-1.5 text-[13px] text-neutral-300">
                    {event.prizes.map((p, i) => (
                      <div key={i}>{p}</div>
                    ))}
                  </div>
                </div>
              ) : null}
              {event.rules.length ? (
                <div>
                  <Kick className="mb-2.5">Rules</Kick>
                  <div className="flex flex-col gap-[7px] text-[13.5px] text-neutral-300">
                    {event.rules.map((r, i) => (
                      <div key={i}>{r}</div>
                    ))}
                  </div>
                </div>
              ) : null}
              {event.coordinators.length ? (
                <div>
                  <Kick className="mb-2.5">Coordinators</Kick>
                  <div className="flex flex-col gap-[9px] text-[13.5px]">
                    {event.coordinators.map((c, i) => (
                      <div key={i}>
                        {c.name}
                        {c.phone || c.email ? (
                          <div className="text-[12px] text-neutral-500">
                            {c.phone ? <a href={`tel:${c.phone}`} className="text-inherit no-underline">{c.phone}</a> : null}
                            {c.phone && c.email ? " · " : null}
                            {c.email ? <a href={`mailto:${c.email}`} className="text-inherit no-underline">{c.email}</a> : null}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <RegisterPanel event={event} fest={fest} />
        </div>

        {hasTeamProfile(event.coordinators) ? <Team01 members={event.coordinators} /> : null}
      </Page>
      </main>
      <StudentTapBar />
    </div>
  );
}
