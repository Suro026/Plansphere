"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Kick } from "@/components/ui/primitives";

/**
 * Route-level error boundary. Keeps the shell out of it on purpose: if the
 * failure was in a provider, rendering the nav again would fail again.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    console.error(error);
    // Imported on demand: the SDK is only needed once something has already gone wrong.
    void import("@sentry/nextjs").then((Sentry) => Sentry.captureException(error));
  }, [error]);

  return (
    <main id="main" className="mx-auto flex min-h-dvh w-full max-w-[720px] flex-col justify-center px-[18px] py-16 sm:px-6">
      <Kick className="mb-2">Something broke</Kick>
      <h1 className="mb-3 text-[32px] font-medium leading-[1.05] tracking-[-0.03em] sm:text-[40px]">This page didn’t load</h1>
      <p className="mb-2 max-w-[48ch] text-[15px] text-neutral-300">
        Nothing you did caused it, and nothing was lost — registrations and scans are written on the server, not in this tab. Try again; if it keeps
        happening, the reference below helps us find it.
      </p>
      {error.digest ? <div className="code mb-7 text-[12px] text-neutral-500">ref {error.digest}</div> : <div className="mb-7" />}
      <div className="flex flex-wrap gap-2.5">
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Button asChild variant="ghost">
          <Link href="/">Home</Link>
        </Button>
      </div>
    </main>
  );
}
