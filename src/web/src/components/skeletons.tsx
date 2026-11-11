import { cn } from "@/lib/utils";
import { Skeleton } from "./ui/skeleton";

/** Row widths that look like real titles, cycled so a list never looks striped. */
const WIDTHS = ["62%", "48%", "71%", "55%", "38%", "66%", "44%"];

/** Skeleton rows the height of real list rows (28 px), for the sidebar and lists. */
export function SkeletonRows({ count = 4, className, withIcon = false }: { count?: number; className?: string; withIcon?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-0.5 motion-safe:animate-skeleton", className)} aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex h-7 items-center gap-2 px-2">
          {withIcon ? <Skeleton className="size-4 shrink-0 animate-none rounded-[4px]" /> : null}
          <Skeleton className="h-2.5 animate-none" style={{ width: WIDTHS[i % WIDTHS.length] }} />
        </div>
      ))}
    </div>
  );
}

/** A conversation loading: a short user bubble and an answer of three lines. */
export function SkeletonTurns() {
  return (
    <div className="mx-auto flex w-full max-w-(--chat-max-width) flex-col gap-8 px-4 pt-10 motion-safe:animate-skeleton" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-6">
          <Skeleton className="ml-auto h-9 w-[42%] animate-none rounded-xl" />
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-2.5 w-[92%] animate-none" />
            <Skeleton className="h-2.5 w-[84%] animate-none" />
            <Skeleton className="h-2.5 w-[58%] animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Settings-style card rows: a label line and a value line per row. */
export function SkeletonCard({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("divide-y rounded-xl border motion-safe:animate-skeleton", className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-3.5 py-3">
          <Skeleton className="size-5 animate-none rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-2.5 animate-none" style={{ width: WIDTHS[i % WIDTHS.length] }} />
            <Skeleton className="h-2 w-1/4 animate-none" />
          </div>
          <Skeleton className="h-6 w-16 animate-none rounded-md" />
        </div>
      ))}
    </div>
  );
}
