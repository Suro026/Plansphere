"use client";

import * as React from "react";
import Link from "next/link";
import { CaretRight } from "@phosphor-icons/react";
import type { Fest } from "@/core/models/fest";
import { Field, Input, RadioOption, Seg } from "@/components/ui/field";
import { AnimatedList, Artwork, EmptyState, Kick, Tag } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { FestCard, festPhase } from "./fest-card";
import { formatDateRange } from "@/lib/utils";

export interface FestWithStats {
  fest: Fest;
  events: number;
  registered: number;
}

type When = "now" | "month" | "quarter" | "any";
type View = "grid" | "list";

const WHEN_OPTIONS: Array<{ value: When; label: string }> = [
  { value: "now", label: "Happening now" },
  { value: "month", label: "This month" },
  { value: "quarter", label: "Next 3 months" },
  { value: "any", label: "Any time" },
];

const inWindow = (fest: Fest, when: When, today: Date): boolean => {
  const ymd = today.toISOString().slice(0, 10);
  if (when === "any") return true;
  if (when === "now") return fest.startDate <= ymd && fest.endDate >= ymd;
  const horizon = new Date(today);
  horizon.setMonth(horizon.getMonth() + (when === "month" ? 1 : 3));
  const limit = horizon.toISOString().slice(0, 10);
  return fest.endDate >= ymd && fest.startDate <= limit;
};

/**
 * 1b — filter-first discovery. Desktop: a 236px filter rail beside a 3-up
 * grid. Phone: search plus a filter chip rail above a list with 60px thumbs.
 * The same component renders both; only the layout classes change.
 */
export const ExploreBoard = ({ items }: { items: FestWithStats[] }) => {
  const today = React.useMemo(() => new Date(), []);
  const cities = React.useMemo(
    () => [...new Set(items.map((i) => i.fest.city).filter(Boolean))].sort(),
    [items],
  );

  const [search, setSearch] = React.useState("");
  const [city, setCity] = React.useState<string>("");
  const [when, setWhen] = React.useState<When>(() =>
    items.some((i) => inWindow(i.fest, "now", today)) ? "now" : "any",
  );
  const [view, setView] = React.useState<View>("grid");

  const filtered = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return items
      .filter(({ fest }) => (city ? fest.city === city : true))
      .filter(({ fest }) => inWindow(fest, when, today))
      .filter(({ fest }) =>
        term ? [fest.name, fest.organizationName, fest.city, fest.venue].some((v) => v?.toLowerCase().includes(term)) : true,
      )
      .sort((a, b) => a.fest.startDate.localeCompare(b.fest.startDate));
  }, [items, city, when, search, today]);

  const reset = () => {
    setSearch("");
    setCity("");
    setWhen("any");
  };

  const heading = `${filtered.length} ${filtered.length === 1 ? "fest" : "fests"}${city ? ` in ${city}` : ""}`;

  return (
    <div className="mx-auto w-full max-w-[1180px] flex-1">
      {/* Page header — editorial, both breakpoints get it */}
      <div className="border-b border-divider px-[18px] pb-6 pt-8 md:px-9 md:pb-8 md:pt-12">
        <span className="mb-3 block text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-600">
          [ explore ]
        </span>
        <h1 className="text-[32px] leading-[0.96] tracking-[-0.025em] md:text-[44px] md:leading-[0.92] md:tracking-[-0.03em]">
          Every fest, <em className="text-emphasis text-accent not-italic md:italic">in one place.</em>
        </h1>
      </div>

      {/* Phone header: search, chip rail */}
      <div className="px-[18px] pb-3 pt-4 md:hidden">
        <Input
          type="search"
          placeholder="Search fest, college or city"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-2.5"
          aria-label="Search fests"
        />
        <div className="flex gap-[11px] overflow-x-auto scrollbar-none">
          <select
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className="tag tag-outline flex-none cursor-pointer appearance-none bg-transparent pr-6"
            aria-label="City"
            style={{ backgroundImage: "none" }}
          >
            <option value="">All cities ▾</option>
            {cities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {WHEN_OPTIONS.filter((o) => o.value !== "any").map((o) => (
            <button
              key={o.value}
              type="button"
              className={`tag flex-none cursor-pointer ${when === o.value ? "tag-accent" : "tag-neutral"}`}
              onClick={() => setWhen(when === o.value ? "any" : o.value)}
              aria-pressed={when === o.value}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[236px_1fr] md:min-h-[640px]">
        {/* Desktop filter rail */}
        <aside className="hidden flex-col gap-[22px] border-r border-divider px-[26px] pb-[30px] pt-[30px] md:flex">
          <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-600">Filters</span>
          <Field label="Search" htmlFor="explore-search">
            <Input
              id="explore-search"
              type="search"
              placeholder="Fest, college or venue"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <Field label="City" htmlFor="explore-city">
            <select id="explore-city" className="input" value={city} onChange={(e) => setCity(e.target.value)}>
              <option value="">All cities</option>
              {cities.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <div>
            <Kick className="mb-[9px]">When</Kick>
            {WHEN_OPTIONS.map((o) => (
              <RadioOption key={o.value} block name="when" label={o.label} checked={when === o.value} onChange={() => setWhen(o.value)} />
            ))}
          </div>
          <Button variant="secondary" block className="mt-auto" onClick={reset}>
            Reset filters
          </Button>
        </aside>

        {/* Results */}
        <section className="px-[18px] pb-[34px] pt-3 md:px-9 md:pt-[30px]">
          <div className="mb-7 hidden items-end justify-between md:flex">
            <div>
              <h2 className="mb-[5px] text-[24px] tracking-[-0.02em]">{heading}</h2>
              <div className="text-[12px] text-neutral-600">Sorted by start date</div>
            </div>
            <Seg
              value={view}
              onChange={setView}
              options={[
                { value: "grid", label: "Grid" },
                { value: "list", label: "List" },
              ]}
              aria-label="Layout"
            />
          </div>

          <Kick className="pb-2.5 pt-3.5 md:hidden">{when === "now" ? "Happening now" : heading}</Kick>

          {filtered.length === 0 ? (
            <EmptyState
              title="Nothing matches those filters"
              body="Try a wider date range or clear the city. New fests appear here as soon as a college publishes them."
              action={
                <Button variant="secondary" onClick={reset}>
                  Reset filters
                </Button>
              }
            />
          ) : (
            <>
              {/* Phone + list view: rows */}
              <AnimatedList stagger={30} maxDelay={240} variant="fade" className={view === "list" ? "block" : "block md:hidden"}>
                {filtered.map(({ fest, events, registered }) => {
                  const phase = festPhase(fest, today);
                  return (
                    <Link
                      key={fest.id}
                      href={`/f/${fest.slug}`}
                      className="rule-b flex gap-3 py-[13px] text-inherit no-underline"
                    >
                      <Artwork src={fest.logoUrl ?? fest.thumbnailUrl ?? fest.bannerUrl} className="h-[60px] w-[60px] flex-none rounded-md" alt="" />
                      <div className="min-w-0 flex-1">
                        <div className="mb-[3px] flex items-center gap-2">
                          <span className="truncate text-[15px] font-medium tracking-[-0.01em]">{fest.name}</span>
                          {phase.live ? <Tag tone="accent">Live</Tag> : null}
                        </div>
                        <div className="mb-[5px] text-[12px] text-neutral-300">{fest.organizationName}</div>
                        <div className="flex flex-wrap gap-x-2.5 text-[11px] text-neutral-500">
                          <span>{formatDateRange(fest.startDate, fest.endDate)}</span>
                          <span>·</span>
                          <span>{events} events</span>
                          <span>·</span>
                          <span>{registered.toLocaleString("en-IN")} registered</span>
                        </div>
                      </div>
                      <CaretRight size={16} className="self-center text-neutral-600" />
                    </Link>
                  );
                })}
              </AnimatedList>

              {/* Desktop grid */}
              {view === "grid" ? (
                <AnimatedList stagger={40} maxDelay={320} className="hidden grid-cols-2 gap-x-[18px] gap-y-8 md:grid lg:grid-cols-3">
                  {filtered.map(({ fest, events, registered }) => (
                    <div key={fest.id} className="transition-transform duration-200 hover:-translate-y-1">
                      <FestCard fest={fest} variant="full" stats={{ events, registered }} />
                    </div>
                  ))}
                </AnimatedList>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
};
