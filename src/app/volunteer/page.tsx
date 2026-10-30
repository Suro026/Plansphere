"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useVolunteerFests } from "@/components/shell/volunteer-shell";
import { Brand } from "@/components/shell/brand";
import { UserMenu } from "@/components/shell/user-menu";
import { EmptyState, Kick, Skeleton, Tag } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { formatDateRange } from "@/lib/utils";

/** /volunteer — straight to the one fest you are rostered on, or a pick list. */
export default function VolunteerIndexPage() {
  const fests = useVolunteerFests();
  const router = useRouter();

  React.useEffect(() => {
    if (fests.data?.length === 1 && fests.data[0]) router.replace(`/volunteer/${fests.data[0].slug}`);
  }, [fests.data, router]);

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-divider">
        <nav className="nav mx-auto w-full max-w-[1180px] px-[18px] py-3.5 sm:px-6" aria-label="Volunteer">
          <Brand href="/volunteer" role="VOLUNTEER" />
          <UserMenu variant="admin" />
        </nav>
      </header>
      <main id="main" className="mx-auto w-full max-w-[720px] flex-1 px-[18px] py-6 sm:px-6">
        <Kick className="mb-2">Your fests</Kick>
        <h4 className="mb-4">Where are you on shift?</h4>
        {fests.isPending ? (
          <Skeleton className="h-40" />
        ) : (fests.data ?? []).length === 0 ? (
          <EmptyState title="No fest yet" body="The admin who created your account adds you to a fest and rosters your shifts." action={<Button asChild variant="secondary"><Link href="/explore">Student side</Link></Button>} />
        ) : (
          <div className="flex flex-col gap-2">
            {(fests.data ?? []).map((f) => {
              const live = f.startDate <= today && f.endDate >= today;
              return (
                <Link key={f.id} href={`/volunteer/${f.slug}`} className="panel flex items-center justify-between gap-3 px-3.5 py-3 text-inherit no-underline hover:bg-surface">
                  <div>
                    <div className="text-[15px] font-medium">{f.name}</div>
                    <div className="text-[11.5px] text-neutral-500">
                      {f.organizationName} · {formatDateRange(f.startDate, f.endDate)}
                    </div>
                  </div>
                  {live ? <Tag tone="accent">Live</Tag> : <Tag tone="neutral">{f.startDate > today ? "Upcoming" : "Ended"}</Tag>}
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
