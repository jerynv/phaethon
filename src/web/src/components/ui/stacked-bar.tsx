import { motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A stacked bar with its legend (docs/UI-REBUILD.md › Primitives › Stacked
 * bar): segments in the categorical `--chart-*` colours, 2 px apart, growing
 * in from the left once; legend rows read "● Label ……… 2,648 (88.03%)".
 */
/** `display` replaces the legend's formatted value (a category's score where `value` is its weight). */
export type BarSegment = { id?: string; label: React.ReactNode; value: number; color?: string; display?: React.ReactNode };

const CHART = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];
export const chartColor = (i: number) => CHART[i % CHART.length]!;

const nf = new Intl.NumberFormat();
export function percentOf(value: number, total: number): string {
  if (!total) return "0%";
  const p = (value / total) * 100;
  return `${p >= 10 ? p.toFixed(1) : p.toFixed(2)}%`;
}

function StackedBar({ segments, className, label }: { segments: BarSegment[]; className?: string; label?: string }) {
  const reduce = useReducedMotion();
  const total = segments.reduce((n, s) => n + Math.max(0, s.value), 0);
  return (
    <div data-slot="stacked-bar" role="img" aria-label={label ?? segments.map((s, i) => `${typeof s.label === "string" ? s.label : i + 1}: ${percentOf(s.value, total)}`).join(", ")} className={cn("flex h-3 w-full gap-0.5 overflow-hidden rounded-sm", className)}>
      {total === 0 ? (
        <div className="h-full flex-1 rounded-xs bg-muted" />
      ) : (
        segments.map((s, i) =>
          s.value > 0 ? (
            <motion.div
              key={s.id ?? i}
              className="h-full min-w-0.5 origin-left first:rounded-l-xs last:rounded-r-xs"
              style={{ flexGrow: s.value, flexBasis: 0, backgroundColor: s.color ?? chartColor(i) }}
              initial={reduce ? false : { scaleX: 0, opacity: 0 }}
              animate={{ scaleX: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 32, delay: i * 0.05 }}
            />
          ) : null,
        )
      )}
    </div>
  );
}

function BarLegend({ segments, className, format = (n) => nf.format(n) }: { segments: BarSegment[]; className?: string; format?: (n: number) => string }) {
  const total = segments.reduce((n, s) => n + Math.max(0, s.value), 0);
  return (
    <ul data-slot="bar-legend" className={cn("flex flex-col gap-1", className)}>
      {segments.map((s, i) => (
        <li key={s.id ?? i} className="flex h-7 items-center gap-2.5 text-sm">
          <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: s.color ?? chartColor(i) }} />
          <span className="min-w-0 flex-1 truncate text-foreground">{s.label}</span>
          <span className="shrink-0 text-foreground tabular-nums">{s.display ?? format(s.value)}</span>
          <span className="w-16 shrink-0 text-right text-muted-foreground tabular-nums">({percentOf(s.value, total)})</span>
        </li>
      ))}
    </ul>
  );
}

export { BarLegend, StackedBar };
