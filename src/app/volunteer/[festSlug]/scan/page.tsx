"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useVolunteerFest } from "@/components/shell/volunteer-shell";
import { Skeleton } from "@/components/ui/primitives";

/**
 * The tap-bar Scan item. Hands off to the shared /scan screen with this
 * fest and whatever the shift already knows (event, post, mode).
 */
export default function VolunteerScanPage() {
  const { fest } = useVolunteerFest();
  const params = useSearchParams();
  const router = useRouter();

  React.useEffect(() => {
    const q = new URLSearchParams(params.toString());
    q.set("fest", fest.slug);
    router.replace(`/scan?${q.toString()}`);
  }, [fest.slug, params, router]);

  return (
    <div className="px-[18px] pt-4" aria-busy>
      <Skeleton className="h-64" />
    </div>
  );
}
