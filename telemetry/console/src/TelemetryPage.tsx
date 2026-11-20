import type { ReactNode } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FilterSelect } from "./FilterSelect";

const PERIODS = [7, 30, 90].map((n) => ({ value: String(n), label: `Last ${n} days` }));

/** The frame Overview and Events share: title, period picker, refresh, and load errors. */
export function TelemetryPage({
  title,
  description,
  days,
  onDaysChange,
  busy,
  refreshing,
  error,
  onRefresh,
  children,
}: {
  title: string;
  description: string;
  days: number;
  onDaysChange: (days: number) => void;
  busy: boolean;
  refreshing: boolean;
  error: string;
  onRefresh: () => void;
  children: ReactNode;
}) {
  return (
    <main className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <FilterSelect
            label="Time period"
            value={String(days)}
            onChange={(value) => onDaysChange(Number(value))}
            options={PERIODS}
            className="w-36"
          />
          <Button size="icon" variant="outline" disabled={busy} aria-label="Refresh" onClick={onRefresh}>
            <Icon icon={icons.reload} className={cn("size-4", busy && "motion-safe:animate-spin")} />
          </Button>
        </div>
      </div>
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-destructive/30 p-3 text-sm text-destructive-foreground"
        >
          {error}
          <Button size="sm" variant="outline" onClick={onRefresh}>
            Retry
          </Button>
        </div>
      ) : null}
      {refreshing ? (
        <span role="status" className="sr-only">
          Refreshing telemetry…
        </span>
      ) : null}
      {children}
    </main>
  );
}
