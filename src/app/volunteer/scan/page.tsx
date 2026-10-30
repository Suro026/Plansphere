"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useVolunteerFests } from "@/components/shell/volunteer-shell";
import { Skeleton } from "@/components/ui/primitives";

/**
 * /volunteer/scan — a fest-agnostic entry point.
 *
 * A volunteer is almost always rostered on exactly one fest, so this hands
 * off to that fest's own scan route (`/volunteer/[festSlug]/scan`, which in
 * turn opens the shared `/scan` screen with the right context already
 * filled in). Kept as its own route because it is the address the spec
 * names and the one worth bookmarking on a gate tablet.
 */
export default function VolunteerScanEntryPage() {
  const fests = useVolunteerFests();
  const router = useRouter();

  React.useEffect(() => {
    if (!fests.data) return;
    if (fests.data.length >= 1 && fests.data[0]) router.replace(`/volunteer/${fests.data[0].slug}/scan`);
    else router.replace("/volunteer");
  }, [fests.data, router]);

  return (
    <div className="min-h-dvh bg-neutral-900 px-[18px] pt-4" aria-busy>
      <Skeleton className="h-64" />
    </div>
  );
}
