import { PublicFooter, PublicNav } from "@/components/shell/public-nav";
import { Skeleton } from "@/components/ui/primitives";

/** Shown while the route's own JS loads; the page's live data has its own skeleton once mounted. */
export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy>
      <PublicNav active="live" />
      <div className="mx-auto w-full max-w-[720px] flex-1 px-[18px] pb-16 pt-8 sm:px-6 sm:pt-14">
        <Skeleton className="mb-3 h-3 w-28" />
        <Skeleton className="mb-6 h-8 w-64" />
        <Skeleton className="h-40" />
      </div>
      <PublicFooter />
    </div>
  );
}
