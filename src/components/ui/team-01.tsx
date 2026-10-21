import { Globe } from "lucide-react";
import type { Coordinator } from "@/core/models/event";
import { Reveal, Tag } from "@/components/ui/primitives";

/**
 * "Meet the team" — the people an organizer lists on their event.
 *
 * Adapted from the 21st.dev Team-01 block to this project's design system
 * (its own tokens and Tag, the shared Reveal entrance instead of the `motion`
 * package, and initials instead of placeholder photos). It is a server
 * component: nothing here needs the browser.
 *
 * The data is the event's `coordinators` — the same list organizers already
 * fill in — so there is nothing extra to maintain.
 */

const LinkedinIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden xmlns="http://www.w3.org/2000/svg">
    <path
      d="M13.633 13.633h-2.37V9.92c0-.885-.017-2.025-1.234-2.025-1.235 0-1.424.965-1.424 1.96v3.778h-2.37V5.998H8.51v1.043h.031a2.5 2.5 0 0 1 2.246-1.233c2.403 0 2.846 1.58 2.846 3.637zM3.56 4.954a1.376 1.376 0 1 1 0-2.751 1.376 1.376 0 0 1 0 2.751m1.185 8.679H2.372V5.998h2.373zM14.815.001H1.18A1.17 1.17 0 0 0 0 1.154v13.691A1.17 1.17 0 0 0 1.18 16h13.635A1.17 1.17 0 0 0 16 14.845V1.153A1.17 1.17 0 0 0 14.815 0"
      fill="currentColor"
    />
  </svg>
);

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

/** True when the organizer gave a member more than a contact line — i.e. there is something to show as a card. */
export const hasTeamProfile = (members: readonly Coordinator[]): boolean =>
  members.some((m) => Boolean(m.role || m.photoUrl || m.linkedinUrl || m.websiteUrl));

export interface Team01Props {
  members: readonly Coordinator[];
  /** Small label above the heading. */
  label?: string;
  heading?: string;
}

const Team01 = ({ members, label = "Team", heading = "Meet the team behind this event" }: Team01Props) => {
  if (members.length === 0) return null;

  return (
    <section aria-labelledby="event-team" className="mt-10 border-t border-divider pt-8">
      <div className="mx-auto flex max-w-xl flex-col items-center gap-3 text-center">
        <Tag tone="outline">{label}</Tag>
        <h2 id="event-team" className="text-[26px] font-medium leading-[1.1] tracking-[-0.02em] sm:text-[32px]">
          {heading}
        </h2>
      </div>

      <ul className="mt-8 grid list-none grid-cols-2 justify-center gap-x-4 gap-y-8 p-0 sm:grid-cols-[repeat(auto-fit,minmax(150px,200px))]">
        {members.map((member, index) => (
          <li key={`${member.name}-${index}`} className="m-0">
            <Reveal delay={Math.min(index, 6) * 80} className="group flex flex-col items-center gap-4 text-center">
              <div className="aspect-square w-full overflow-hidden rounded-lg bg-surface">
                {member.photoUrl ? (
                  // Organizer-uploaded photo; a plain img keeps the server component free of next/image domain config.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={member.photoUrl}
                    alt={member.name}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover transition-all duration-300 group-hover:grayscale"
                  />
                ) : (
                  <div className="grid h-full w-full place-items-center text-[40px] font-medium tracking-[-0.02em] text-neutral-500" aria-hidden>
                    {initials(member.name)}
                  </div>
                )}
              </div>

              <div className="flex flex-col items-center gap-1">
                <h3 className="text-[17px] font-medium leading-tight">{member.name}</h3>
                {member.role ? <p className="text-[13px] text-neutral-500">{member.role}</p> : null}
              </div>

              {member.websiteUrl || member.linkedinUrl ? (
                <div className="flex gap-1.5">
                  {member.websiteUrl ? (
                    <a
                      href={member.websiteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${member.name}’s website`}
                      className="rounded-full p-2 text-neutral-300 hover:bg-surface hover:text-accent"
                    >
                      <Globe size={16} />
                    </a>
                  ) : null}
                  {member.linkedinUrl ? (
                    <a
                      href={member.linkedinUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${member.name} on LinkedIn`}
                      className="rounded-full p-2 text-neutral-300 hover:bg-surface hover:text-accent"
                    >
                      <LinkedinIcon size={16} />
                    </a>
                  ) : null}
                </div>
              ) : null}
            </Reveal>
          </li>
        ))}
      </ul>
    </section>
  );
};

export default Team01;
