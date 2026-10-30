import Link from "next/link";
import { Brand } from "./brand";
import { PublicAuthControls } from "./signed-out-only";
import { ConsentSettingsLink } from "@/components/consent";
import { WordmarkOrb } from "./wordmark-orb";

/**
 * The header for pages seen before sign-in: landing, explorer, public verify.
 * Same `.nav` as the student side; the difference is only which links show.
 *
 * This file deliberately has no knowledge of the homepage's own nav. `/`
 * uses the reference-ported `LandingExperience` (`src/app/_landing/`)
 * instead of `PublicNav` — a plain top-level `import` of a Client Component
 * gets bundled into every page that imports the module it sits in, whether
 * or not that page ever renders it, since Next.js builds the client chunk
 * graph statically. Keeping the homepage's nav out of this file means the
 * other ~15 pages that use `PublicNav` carry none of that weight.
 */
export const PublicNav = ({ active }: { active?: "fests" | "colleges" | "verify" | "live" }) => (
  <header className="sticky top-0 z-40 border-b border-divider bg-bg/85 backdrop-blur-md">
    <nav className="nav mx-auto w-full max-w-[1180px] gap-[26px] px-[18px] py-4 sm:px-6 lg:px-10 lg:py-5" aria-label="Primary">
      <Brand href="/" />
      <Link href="/explore" aria-current={active === "fests" ? "page" : undefined}>
        Fests
      </Link>
      <Link href="/live" aria-current={active === "live" ? "page" : undefined}>
        Live
      </Link>
      <Link href="/for-colleges" aria-current={active === "colleges" ? "page" : undefined} className="hidden sm:inline">
        For colleges
      </Link>
      <Link href="/verify" aria-current={active === "verify" ? "page" : undefined} className="hidden md:inline">
        Verify a certificate
      </Link>
      <div className="ml-3 flex items-center gap-2">
        <PublicAuthControls />
      </div>
    </nav>
  </header>
);

/** Muted tone tuned for text on the footer's ink background — see the
 *  identical pattern in page.tsx for why the plain `text-neutral-*`
 *  utilities (tuned for bone) can't be reused inside an inverted section. */
const footerMuted = "text-[color:color-mix(in_srgb,var(--color-bg)_58%,transparent)]";
const footerDivider = "border-[color:color-mix(in_srgb,var(--color-bg)_16%,transparent)]";

export const PublicFooter = () => (
  <footer className="mt-auto bg-text text-bg">
    <div className="mx-auto w-full max-w-[1180px] px-[18px] py-12 sm:px-6 lg:px-10 lg:py-[72px]">
      <div className="flex flex-col items-start justify-between gap-9 lg:flex-row lg:items-end">
        <Link href="/" className="inline-flex items-center gap-2.5 text-bg no-underline">
          <WordmarkOrb inverted />
          <span className="font-display text-[16px] font-medium tracking-[-0.03em]">Plansphere</span>
        </Link>

        <div className="font-display text-[26px] leading-[0.95] tracking-[-0.03em] sm:text-[32px]">
          Create. Host.
          <br />
          Run every <em className="text-emphasis text-accent-fill">event.</em>
        </div>

        <div className={`flex flex-wrap gap-x-6 gap-y-2 text-[11.5px] uppercase tracking-[0.06em] ${footerMuted}`}>
          <Link href="/explore" className="text-inherit no-underline transition-colors duration-150 hover:text-accent-fill">
            Fests
          </Link>
          <Link href="/for-colleges" className="text-inherit no-underline transition-colors duration-150 hover:text-accent-fill">
            For colleges
          </Link>
          <Link href="/verify" className="text-inherit no-underline transition-colors duration-150 hover:text-accent-fill">
            Verify a certificate
          </Link>
          <Link href="/privacy" className="text-inherit no-underline transition-colors duration-150 hover:text-accent-fill">
            Privacy
          </Link>
          <Link href="/terms" className="text-inherit no-underline transition-colors duration-150 hover:text-accent-fill">
            Terms
          </Link>
          <ConsentSettingsLink className={`text-inherit transition-colors duration-150 hover:text-accent-fill`} />
        </div>
      </div>

      <div className={`my-8 h-px w-full ${footerDivider} lg:my-10`} />

      <div className={`flex flex-wrap items-center justify-between gap-3 text-[10px] uppercase tracking-[0.08em] ${footerMuted}`}>
        <span>© {new Date().getFullYear()} Plansphere</span>
        <span>India</span>
      </div>
    </div>
  </footer>
);
