import Link from "next/link";
import { ArrowRight, ArrowUpRight, QrCode, ScanLine, Trophy, Users } from "lucide-react";
import { FEST_TYPE_LABELS, type FestType } from "@/core/models/fest";
import { Artwork } from "@/components/ui/primitives";
import type { FestPhase, HomeFest } from "./home-data";

/*
 * The landing page's sections below the hero. Server components: nothing here
 * has state. Every event shown comes from real published fests (or an honest
 * empty state) — there are no made-up numbers, quotes or placeholder events.
 */

const EVENT_TONES = ["event-photo-one", "event-photo-two", "event-photo-three"] as const;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const PHASE_LABEL: Record<FestPhase, string> = { live: "Live now", upcoming: "Upcoming", ended: "Ended" };

/** "14—16 MAR", "02 APR", "28 FEB—02 MAR": a fest's real dates. */
const dateRange = (start: string, end: string): string => {
  const [, sm, sd] = start.split("-").map(Number);
  const [, em, ed] = (end || start).split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (!end || end === start) return `${pad(sd!)} ${MONTHS[sm! - 1]}`;
  if (sm === em) return `${pad(sd!)}—${pad(ed!)} ${MONTHS[sm! - 1]}`;
  return `${pad(sd!)} ${MONTHS[sm! - 1]}—${pad(ed!)} ${MONTHS[em! - 1]}`;
};

function FlowItem({
  num,
  icon,
  title,
  detail,
  href,
  active = false,
}: {
  num: string;
  icon: React.ReactNode;
  title: string;
  detail: string;
  href: string;
  active?: boolean;
}) {
  return (
    <Link href={href} className={`flow-item ${active ? "flow-active" : ""}`}>
      <span className="flow-num">{num}</span>
      <span className="flow-icon">{icon}</span>
      <span className="flow-detail">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <ArrowRight size={15} />
    </Link>
  );
}

/**
 * Right after the hero: the fests that are on now and coming up, open to
 * everyone. `items === null` is the Suspense fallback.
 */
export function EventsSection({ items }: { items: HomeFest[] | null }) {
  const hasLive = items?.some((item) => item.phase === "live") ?? false;
  const allEnded = items !== null && items.length > 0 && items.every((item) => item.phase === "ended");
  return (
    <section id="events" className="white-section events-minimal">
      <div className="page-width">
        <div className="events-minimal-head">
          <div>
            <span className="section-index">{allEnded ? "RECENT EVENTS" : hasLive ? "HAPPENING NOW" : "COMING UP"}</span>
            <h2>
              {allEnded ? "Recent events" : "Events on"}
              <br />
              <em>{allEnded ? "on Plansphere." : hasLive ? "right now." : "Plansphere."}</em>
            </h2>
            <p className="events-minimal-sub">Open to everyone. Pick an event, register, and carry your QR pass.</p>
          </div>
          <Link href="/explore" className="circle-arrow" aria-label="Explore all events">
            <ArrowUpRight size={20} />
          </Link>
        </div>
        <div className="minimal-events-grid">
          {items === null ? (
            EVENT_TONES.map((tone, index) => (
              <article key={tone} className="minimal-event" aria-hidden>
                <div className={`minimal-event-image ${tone}`}>
                  <span>0{index + 1}</span>
                  <div className="event-image-lines" />
                </div>
                <div className="minimal-event-meta">
                  <div>
                    <span>—</span>
                    <h3>&nbsp;</h3>
                  </div>
                </div>
              </article>
            ))
          ) : items.length ? (
            items.map(({ fest, phase }, index) => {
              const cover = fest.heroUrl ?? fest.bannerUrl;
              return (
                <article key={fest.id} className="minimal-event">
                  <Link href={`/f/${fest.slug}`} className="minimal-event-link">
                    <div className={`minimal-event-image ${cover ? "has-cover" : EVENT_TONES[index % EVENT_TONES.length]}`}>
                      {cover ? <Artwork src={cover} alt="" lighten={false} className="minimal-event-cover" /> : null}
                      <span className={`event-phase event-phase-${phase}`}>{PHASE_LABEL[phase]}</span>
                      {cover ? null : <div className="event-image-lines" />}
                    </div>
                    <div className="minimal-event-meta">
                      <div>
                        <span>
                          {FEST_TYPE_LABELS[(fest.festType ?? "other") as FestType]} / {fest.city}
                        </span>
                        <h3>{fest.name}</h3>
                      </div>
                      <div>
                        <span>{dateRange(fest.startDate, fest.endDate)}</span>
                        <ArrowUpRight size={14} />
                      </div>
                    </div>
                  </Link>
                </article>
              );
            })
          ) : (
            <div className="minimal-events-empty">
              <strong>No events are listed yet</strong>
              <span>Published fests show up here with their dates and a link to register. Running one? Register it and it appears on this page.</span>
              <Link href="/register-event" className="action-button">
                <span>Register Your Event</span>
                <ArrowUpRight size={15} />
              </Link>
            </div>
          )}
        </div>
        {items !== null && items.length > 0 ? (
          <Link href="/explore" className="text-arrow-button events-all-link">
            See all events <ArrowRight size={16} />
          </Link>
        ) : null}
      </div>
    </section>
  );
}

export function FlowSection() {
  return (
    <section id="flow" className="white-section flow-section">
      <div className="page-width flow-layout">
        <div className="flow-copy">
          <span className="section-index">HOW IT WORKS</span>
          <h2>
            From sign-up
            <br />
            to <em>certificate.</em>
          </h2>
          <p>Organizers set an event up once. Students register, show a QR pass at the gate, and collect results and certificates.</p>
          <Link href="/for-colleges" className="text-arrow-button">
            What organizers get <ArrowRight size={16} />
          </Link>
        </div>
        <div className="flow-list">
          <FlowItem num="01" icon={<Users size={17} />} title="Organizers register the event" detail="Create your fest, add events and registration forms." href="/register-event" active />
          <FlowItem num="02" icon={<QrCode size={17} />} title="Students find & register" detail="Sign up solo or as a team and get a QR pass." href="/explore" />
          <FlowItem num="03" icon={<ScanLine size={17} />} title="Check in at the gate" detail="Volunteers scan passes. No paper lists." href="/for-colleges" />
          <FlowItem num="04" icon={<Trophy size={17} />} title="Results & certificates" detail="Anyone can verify a certificate by its number." href="/verify" />
        </div>
      </div>
    </section>
  );
}
