import { PublicNav } from "@/components/shell/public-nav";
import { Skeleton } from "@/components/ui/primitives";

/** Streamed while the server fetches; same shell, so nothing jumps when data lands. */
export default function Loading() {
  return (
    <div className="flex min-h-dvh flex-col" aria-busy>
      <PublicNav />
      <div className="mx-auto w-full max-w-[1180px] px-[18px] pt-8 sm:px-6 lg:px-10">
        <Skeleton className="mb-3 h-3 w-28" />
        <Skeleton className="mb-6 h-10 w-72" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </div>
    </div>
  );
}
