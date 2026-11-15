import type * as React from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * A number with its label above it ("Total escalations / 3,008"), on a faint
 * grey tile (docs/UI-REBUILD.md › Primitives › Stat tile). `delta` reads as
 * good or bad by its sign unless `tone` says otherwise.
 */
function StatTile({
  label,
  value,
  unit,
  hint,
  delta,
  tone,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Small text after the number ("/ 100", "%"). */
  unit?: React.ReactNode;
  hint?: React.ReactNode;
  /** A change since last time, e.g. +4 or -2.5. */
  delta?: number;
  tone?: "good" | "bad" | "neutral";
}) {
  const t = tone ?? (delta === undefined || delta === 0 ? "neutral" : delta > 0 ? "good" : "bad");
  return (
    <div data-slot="stat-tile" className={cn("flex min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-well px-4 py-3.5", className)} {...props}>
      <span className="truncate text-muted-foreground text-sm">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <span className="font-medium text-2xl text-foreground tabular-nums tracking-heading">{value}</span>
        {unit ? <span className="text-muted-foreground text-sm">{unit}</span> : null}
        {delta !== undefined ? (
          <span
            className={cn(
              "ml-auto inline-flex items-center gap-0.5 text-xs tabular-nums",
              t === "good" ? "text-success-foreground" : t === "bad" ? "text-destructive-foreground" : "text-muted-foreground",
            )}
          >
            {delta !== 0 ? <Icon icon={delta > 0 ? icons.trendUp : icons.trendDown} className="size-3.5" /> : null}
            {delta > 0 ? "+" : ""}
            {delta}
          </span>
        ) : null}
      </span>
      {hint ? <span className="truncate text-subtle-foreground text-xs">{hint}</span> : null}
    </div>
  );
}

/** Tiles in a grid: two across in a card, up to four on a page. */
function StatGrid({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="stat-grid" className={cn("grid grid-cols-2 gap-3 @2xl:grid-cols-4", className)} {...props} />;
}

export { StatGrid, StatTile };
