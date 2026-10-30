import { Skeleton } from "@/components/ui/primitives";

/**
 * Shown while this route segment's own JS chunk loads on a cold visit —
 * matches FestProvider's own loading branch (admin-shell.tsx) exactly, so
 * there's no flash of a different layout once that takes over a moment
 * later; it's the same skeleton, just visible slightly earlier.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 py-10 lg:px-8" aria-busy>
      <Skeleton className="mb-6 h-9 w-full max-w-[720px]" />
      <Skeleton className="h-64" />
    </div>
  );
}
