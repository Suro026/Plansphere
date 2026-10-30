import * as React from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Brand } from "@/components/shell/brand";
import { HeroField, Kick, Skeleton } from "@/components/ui/primitives";

/**
 * Auth screens — designed to fill a gap in the canvas, in its own idiom.
 *
 * Left-aligned form column at the design's compact density; on desktop the
 * marquee's promise sits beside it as a quiet reminder of what the account is
 * for. No card, no centred box: Nocturne's layouts hug the left edge and let
 * whitespace do the rest.
 */
export const metadata: Metadata = {
  // A nested template so route titles keep the brand suffix (a template only
  // applies to the segment directly below the layout that defines it).
  title: { default: "Account", template: "%s · Plansphere" },
  description: "Sign in to Plansphere or create your student account.",
  robots: { index: false, follow: false },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header>
        <nav className="nav mx-auto w-full max-w-[1180px] gap-[26px] px-[18px] py-4 sm:px-6 lg:px-10" aria-label="Primary">
          <Brand href="/" />
          <Link href="/explore">Fests</Link>
          <Link href="/verify" className="hidden sm:inline">
            Verify a certificate
          </Link>
        </nav>
      </header>

      <main id="main" className="mx-auto grid w-full max-w-[1180px] flex-1 grid-cols-1 gap-12 px-[18px] pb-16 pt-6 sm:px-6 sm:pt-12 lg:grid-cols-[minmax(0,420px)_1fr] lg:gap-20 lg:px-10">
        <div className="w-full">
          {/* useSearchParams() in the pages bails out of static prerender;
              Suspense gives the shell something to render meanwhile. */}
          <React.Suspense
            fallback={
              <div aria-busy>
                <Skeleton className="mb-3 h-3 w-24" />
                <Skeleton className="mb-8 h-9 w-64" />
                <Skeleton className="mb-4 h-10" />
                <Skeleton className="h-10" />
              </div>
            }
          >
            {children}
          </React.Suspense>
        </div>

        <aside className="hidden lg:block">
          <div className="relative h-[420px] overflow-hidden rounded-lg">
            <HeroField className="absolute inset-0 h-full w-full" seed={11} />
            <div
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(to top, var(--color-bg) 4%, color-mix(in srgb, var(--color-bg) 72%, transparent) 38%, transparent 72%)",
              }}
            />
            <div className="absolute inset-x-6 bottom-6">
              <Kick className="mb-2 text-accent-300">Every fest. One pass.</Kick>
              <p className="max-w-[40ch] text-[14px] text-neutral-300">
                Register once, show a QR at the gate, and keep every ticket, meal slot and certificate in one place.
              </p>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
