import type { Metadata } from "next";
import Link from "next/link";
import { PublicFooter, PublicNav } from "@/components/shell/public-nav";
import { Kick } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

/** Global 404 — also what `notFound()` renders for an unknown fest or event slug. */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <PublicNav />
      <main id="main" className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center px-[18px] py-16 sm:px-6">
        <Kick className="mb-2">404</Kick>
        <h1 className="mb-3 text-[36px] leading-[0.98] tracking-[-0.03em] sm:text-[48px] sm:leading-[0.94]">Nothing at this address</h1>
        <p className="mb-8 max-w-[48ch] text-[15px] text-neutral-400">
          The fest or event may have been unpublished, or the link was copied short. Everything currently open to register is on Explore.
        </p>
        <div className="flex flex-wrap gap-2.5">
          <Link href="/explore" className="btn btn-fill">
            Explore Events
          </Link>
          <Link href="/register-event" className="btn btn-secondary">
            Register Your Event
          </Link>
          <Link href="/" className="btn btn-ghost">
            Return home
          </Link>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
