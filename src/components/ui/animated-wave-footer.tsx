import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ConsentSettingsLink } from "@/components/consent";
import { SITE } from "@/lib/site";

/**
 * The landing page's footer: the animated-wave footer layout, built from
 * Plansphere's own tokens and the landing page's `.action-button` styles. Everything in it is a
 * real route or a real address from `SITE` — no placeholder address, no
 * newsletter form without a backend, no social links we don't have.
 *
 * The logo is the original `/logo.png`, dark ink on transparent, so the footer
 * is a light surface rather than the dark one the old footer needed a backing
 * chip for.
 */

const linkClass = "block w-fit text-neutral-300 no-underline transition-colors duration-150 hover:text-accent";
const headingClass = "mb-4 font-display text-[15px] font-medium tracking-[-0.03em] text-text";

const students = [
  { href: "/explore", label: "Explore events" },
  { href: "/live", label: "Live scores" },
  { href: "/verify", label: "Verify a certificate" },
] as const;

const organizers = [
  { href: "/register-event", label: "Register your event" },
  { href: "/for-colleges", label: "For colleges" },
  { href: "/sign-in", label: "Sign in" },
  { href: "/create-account", label: "Create account" },
] as const;

const contact = [
  { label: "General", email: SITE.contact.hello },
  { label: "Support", email: SITE.contact.support },
  { label: "Privacy", email: SITE.contact.privacy },
] as const;

/** One tile of wave artwork; two sit side by side so the loop has no seam. */
function WaveTile() {
  return (
    <svg className="h-full w-[1800px] shrink-0" viewBox="0 0 1800 500" preserveAspectRatio="none" aria-hidden="true">
      <path
        d="M0 250C200 150 400 50 600 100C800 150 1000 350 1200 300C1400 250 1600 150 1800 250V500H0V250Z"
        fill="currentColor"
        className="text-accent-fill/35"
      />
      <path
        d="M0 250C200 200 400 100 600 150C800 200 1000 350 1200 300C1400 250 1600 200 1800 250V500H0V250Z"
        fill="currentColor"
        className="text-accent-fill/60"
      />
    </svg>
  );
}

export default function AnimatedWaveFooter({ actions }: { actions?: React.ReactNode }) {
  return (
    <footer className="relative overflow-hidden bg-linear-to-b from-bg to-accent-fill/30 pt-20 text-text">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[420px]" aria-hidden="true">
        <div className="flex h-full w-[3600px] animate-wave motion-reduce:animate-none">
          <WaveTile />
          <WaveTile />
        </div>
      </div>

      <div className="relative z-10 mx-auto w-full max-w-[1200px] px-[18px] sm:px-8 lg:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.75fr_1fr_1fr_1.1fr]">
          <div>
            <Link href="/" aria-label="Plansphere home" className="inline-flex h-12 items-center overflow-hidden">
              <Image src="/logo.png" alt="" width={160} height={80} className="h-20 w-40 max-w-none" />
            </Link>
            <p className="mt-4 max-w-[330px] text-[13px] leading-[1.65] text-neutral-300">{SITE.description}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/register-event" className="action-button">
                <span>Register Your Event</span>
                <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
              <Link href="/explore" className="action-button action-outline">
                <span>Explore Events</span>
                <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
            </div>
          </div>

          <nav aria-label="For students" className="text-[13px]">
            <h3 className={headingClass}>For students</h3>
            <ul className="space-y-2.5">
              {students.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className={linkClass}>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="For organizers" className="text-[13px]">
            <h3 className={headingClass}>For organizers</h3>
            <ul className="space-y-2.5">
              {organizers.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className={linkClass}>
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="text-[13px]">
            <h3 className={headingClass}>Contact</h3>
            <ul className="space-y-2.5">
              {contact.map((item) => (
                <li key={item.email}>
                  <span className="block text-[11px] uppercase tracking-[0.08em] text-neutral-400">{item.label}</span>
                  <a href={`mailto:${item.email}`} className={linkClass}>
                    {item.email}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-divider py-7 text-[12px] text-neutral-400 sm:flex-row sm:items-center sm:justify-between">
          <span>
            © {new Date().getFullYear()} {SITE.legalName} · India
          </span>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link href="/privacy" className="text-inherit no-underline transition-colors hover:text-accent">
              Privacy
            </Link>
            <Link href="/terms" className="text-inherit no-underline transition-colors hover:text-accent">
              Terms
            </Link>
            <ConsentSettingsLink className="text-inherit transition-colors hover:text-accent" />
            {actions}
          </div>
        </div>
      </div>
    </footer>
  );
}
