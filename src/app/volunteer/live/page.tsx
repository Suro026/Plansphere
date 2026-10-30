"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useVolunteerFests } from "@/components/shell/volunteer-shell";
import { Skeleton } from "@/components/ui/primitives";

/**
 * /volunteer/live — a fest-agnostic entry point, the same shape as
 * /volunteer/scan: hands off to `/volunteer/[festSlug]/live`, the address a
 * volunteer would actually bookmark once they know which fest they are on.
 */
export default function VolunteerLiveEntryPage() {
  const fests = useVolunteerFests();
  const router = useRouter();

  React.useEffect(() => {
    if (!fests.data) return;
    if (fests.data.length >= 1 && fests.data[0]) router.replace(`/volunteer/${fests.data[0].slug}/live`);
    else router.replace("/volunteer");
  }, [fests.data, router]);

  return (
    <div className="min-h-dvh bg-neutral-900 px-[18px] pt-4" aria-busy>
      <Skeleton className="h-64" />
    </div>
  );
}
