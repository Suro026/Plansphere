import Link from "next/link";
import type { Event } from "@/core/models/event";
import { categoryLabel, isRegistrationOpen, seatsRemaining } from "@/core/models/event";
import { Artwork, Tag } from "@/components/ui/primitives";
import { formatCalendarDate, formatTeamSize } from "@/lib/utils";

/** "17 seats left" / "Closes tonight" / "Waitlist" / "Full" — the card's one-line state. */
export const seatLine = (event: Event, now = new Date()): { text: string; urgent: boolean } => {
  const left = seatsRemaining(event);
  const open = isRegistrationOpen(event, now);

  if (event.status === "completed") return { text: "Ended", urgent: false };
  if (event.status === "cancelled") return { text: "Cancelled", urgent: false };
  if (!open && left === 0) return { text: event.waitlistEnabled ? "Waitlist" : "Full", urgent: false };
  if (!open) return { text: "Closed", urgent: false };

  if (event.registrationDeadline) {
    const today = now.toISOString().slice(0, 10);
    if (event.registrationDeadline === today) return { text: "Closes tonight", urgent: true };
  }

  if (left !== null) return { text: `${left} ${left === 1 ? "seat" : "seats"} left`, urgent: left <= 20 };
  return { text: "Open", urgent: false };
};

export interface EventCardProps {
  event: Event;
  festSlug: string;
  /** The 1a rail card (158px, no chrome) vs the grid card. */
  variant?: "grid" | "rail";
}

export const EventCard = ({ event, festSlug, variant = "grid" }: EventCardProps) => {
  const href = `/f/${festSlug}/e/${event.slug}`;
  const seats = seatLine(event);

  if (variant === "rail") {
    return (
      <Link href={href} className="block w-[158px] flex-none text-inherit no-underline">
        <Artwork src={event.posterUrl} label="event poster" className="mb-2 h-[104px] rounded-md" alt="" />
        <div className="text-[13.5px] font-medium leading-[1.25]">{event.title}</div>
        <div className="mt-1 text-[11px] text-accent-300">
          {seats.text} · {formatTeamSize(event.eventType, event.teamSize).toLowerCase()}
        </div>
      </Link>
    );
  }

  return (
    <article className="card elev-sm overflow-hidden p-0">
      <Link href={href} className="block text-inherit no-underline">
        <Artwork src={event.posterUrl} label="event poster" className="h-[132px]" alt="" />
      </Link>
      <div className="flex flex-col gap-[7px] px-[15px] pb-4 pt-3.5">
        <div className="card-kicker">{categoryLabel(event.category)}</div>
        <Link href={href} className="card-title text-inherit no-underline hover:text-accent">
          {event.title}
        </Link>
        <div className="text-[12px] text-neutral-300">
          {formatCalendarDate(event.date)} · {event.startTime} · {event.venue}
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <Tag tone="outline" className={seats.urgent ? "" : "opacity-90"}>
            {seats.text}
          </Tag>
          <Link href={href} className="btn btn-ghost text-[12.5px]">
            {isRegistrationOpen(event) ? "Register" : "Details"}
          </Link>
        </div>
      </div>
    </article>
  );
};
