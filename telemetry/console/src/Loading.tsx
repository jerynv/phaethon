import { Skeleton } from "@/components/ui/skeleton";

export function ConsoleLoading() {
  return <div role="status" aria-label="Opening console" className="flex h-svh"><aside aria-hidden className="hidden w-[248px] shrink-0 space-y-8 border-r bg-sidebar p-6 md:block"><Skeleton className="h-5 w-28" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></aside><div className="min-w-0 flex-1"><div aria-hidden className="h-14 border-b" /><div className="space-y-7 p-5 sm:p-10"><Skeleton className="h-7 w-40" /><OverviewSkeleton /></div></div><span className="sr-only">Opening console…</span></div>;
}

export function OverviewSkeleton() {
  return <div role="status" aria-label="Loading telemetry" className="space-y-5"><span className="sr-only">Loading telemetry…</span><div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <div key={i} className="space-y-4 rounded-card border bg-card p-5"><Skeleton className="h-3 w-20" /><Skeleton className="h-8 w-12" /></div>)}</div><div className="grid gap-4 xl:grid-cols-[2fr_1fr_1fr]">{Array.from({ length: 3 }, (_, i) => <div key={i} className="space-y-6 rounded-card border bg-card p-5"><Skeleton className="h-4 w-28" /><Skeleton className="h-36 w-full" /></div>)}</div></div>;
}

export function TableSkeleton({ columns = 5, rows = 4 }: { columns?: number; rows?: number }) {
  return <div role="status" aria-label="Loading events" className="overflow-hidden rounded-card border bg-card"><span className="sr-only">Loading events…</span><div className="flex gap-6 border-b bg-well px-4 py-3">{Array.from({ length: columns }, (_, i) => <Skeleton key={i} className="h-3 flex-1" />)}</div>{Array.from({ length: rows }, (_, i) => <div key={i} className="flex gap-6 border-b px-4 py-5 last:border-0">{Array.from({ length: columns }, (_, j) => <Skeleton key={j} className="h-4 flex-1" />)}</div>)}</div>;
}
