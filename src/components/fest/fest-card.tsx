import Link from "next/link";
import type { Fest } from "@/core/models/fest";
import { Artwork, Tag } from "@/components/ui/primitives";
import { formatDateRange } from "@/lib/utils";

/** Live / Open / Soon, from the fest's dates relative to today. */
export const festPhase = (fest: Fest, today = new Date()): { label: string; live: boolean } => {
  const ymd = today.toISOString().slice(0, 10);
  if (fest.startDate <= ymd && fest.endDate >= ymd) return { label: "Live", live: true };
  if (fest.startDate > ymd) {
    const days = Math.round((new Date(fest.startDate).getTime() - new Date(ymd).getTime()) / 86400000);
    return { label: days > 21 ? "Soon" : "Open", live: false };
  }
  return { label: "Ended", live: false };
};

export interface FestCardProps {
  fest: Fest;
  stats?: { events?: number; registered?: number };
  /** The landing's compact card (4a) vs the explorer's fuller one (1b). */
  variant?: "compact" | "full";
}

export const FestCard = ({ fest, stats, variant = "compact" }: FestCardProps) => {
  const phase = festPhase(fest);
  const href = `/f/${fest.slug}`;

  return (
    <article className="card elev-sm overflow-hidden p-0">
      <Link href={href} className="block no-underline text-inherit">
        <Artwork src={fest.thumbnailUrl ?? fest.bannerUrl} label="fest banner" className="h-[118px]" alt="" />
      </Link>
      <div className="flex flex-col gap-2 px-[15px] pb-[15px] pt-3.5">
        <Tag tone={phase.live ? "accent" : "neutral"} className="self-start">
          {phase.label}
        </Tag>
        <Link href={href} className="card-title no-underline text-inherit hover:text-accent">
          {fest.name}
        </Link>
        {variant === "compact" ? (
          <div className="text-[12px] text-neutral-500">
            {fest.organizationName} · {formatDateRange(fest.startDate, fest.endDate)}
          </div>
        ) : (
          <>
            <div className="text-[12px] text-neutral-300">{fest.organizationName}</div>
            <div className="mt-0.5 flex flex-col gap-1 text-[11.5px] text-neutral-500">
              <div className="flex justify-between">
                <span>Dates</span>
                <span className="text-neutral-200">{formatDateRange(fest.startDate, fest.endDate)}</span>
              </div>
              <div className="flex justify-between">
                <span>Events</span>
                <span className="text-neutral-200">{stats?.events ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span>Registered</span>
                <span className="text-neutral-200">{stats?.registered?.toLocaleString("en-IN") ?? "—"}</span>
              </div>
            </div>
            <Link href={href} className="btn btn-primary btn-block mt-2">
              View fest
            </Link>
          </>
        )}
      </div>
    </article>
  );
};
