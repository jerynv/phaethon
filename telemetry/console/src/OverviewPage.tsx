import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  CATEGORY_LABELS,
  TELEMETRY_CATEGORIES,
  eventName,
  formatCount,
  type EventPage,
  type EventSummary,
  type Overview,
  type TelemetryCategory,
} from "./api";
import { EventList } from "./EventList";
import { OverviewSkeleton, TableSkeleton } from "./Loading";

const RECENT_EVENTS = 5;

export function OverviewPage({
  busy,
  overview,
  events,
  selectedId,
  onOpenCategory,
  onOpenEvent,
  onViewAll,
}: {
  busy: boolean;
  overview: Overview | null;
  events: EventPage | null;
  selectedId: string | undefined;
  onOpenCategory: (category: TelemetryCategory) => void;
  onOpenEvent: (event: EventSummary) => void;
  onViewAll: () => void;
}) {
  const recent = events?.items.slice(0, RECENT_EVENTS) ?? [];
  return (
    <>
      {!overview && busy ? <OverviewSkeleton /> : null}
      {overview ? (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {TELEMETRY_CATEGORIES.map((category) => (
              <button
                key={category}
                onClick={() => onOpenCategory(category)}
                className="cursor-pointer rounded-card border bg-card p-4 text-left outline-none transition-colors hover:border-border-strong hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="text-xs text-muted-foreground">{CATEGORY_LABELS[category]}</span>
                <span className="mt-2 block text-2xl font-medium tabular-nums">
                  {formatCount(overview.totals[category] ?? 0)}
                </span>
              </button>
            ))}
          </div>
          <div className="grid gap-4 xl:grid-cols-[2fr_1fr_1fr]">
            <Activity points={overview.days} />
            <Breakdown
              title="Events"
              rows={overview.events.map((e) => ({ name: e.event, count: e.count }))}
            />
            <Breakdown
              title="Attempt outcomes"
              rows={overview.outcomes.map((e) => ({ name: e.outcome, count: e.count }))}
            />
          </div>
        </>
      ) : null}
      <section className="min-w-0" aria-busy={busy}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Recent events</h2>
          <Button size="sm" variant="ghost" onClick={onViewAll}>
            View all events
            <Icon icon={icons.external} className="size-3.5" />
          </Button>
        </div>
        {!events && busy ? <TableSkeleton /> : null}
        {events ? (
          <EventList
            items={recent}
            selectedId={selectedId}
            onOpen={onOpenEvent}
            showEmpty={!busy && !recent.length}
            filtered={false}
          />
        ) : null}
      </section>
    </>
  );
}

function Activity({ points }: { points: Overview["days"] }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  return (
    <section className="rounded-card border bg-card p-4">
      <h2 className="text-sm font-medium">Events over time</h2>
      {points.length ? (
        <>
          <div
            className="mt-5 flex h-36 items-end gap-1"
            role="img"
            aria-label={points.map((p) => `${p.day}: ${p.count} events`).join("; ")}
          >
            {points.map((p) => (
              <div key={p.day} className="flex h-full min-w-0 flex-1 items-end">
                <div
                  title={`${p.day}: ${formatCount(p.count)}`}
                  className="w-full rounded-t-sm bg-primary/75"
                  // Any non-zero day keeps a visible sliver.
                  style={{ height: `${Math.max(p.count ? 2 : 0, (p.count / max) * 100)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            <span>{points[0]?.day}</span>
            <span>{points.at(-1)?.day}</span>
          </div>
        </>
      ) : (
        <p className="py-12 text-sm text-muted-foreground">No events in this period.</p>
      )}
    </section>
  );
}

function Breakdown({ title, rows }: { title: string; rows: { name: string; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <section className="rounded-card border bg-card p-4">
      <h2 className="mb-4 text-sm font-medium">{title}</h2>
      {rows.length ? (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => (
            <li key={r.name}>
              <div className="mb-1 flex justify-between gap-3 text-xs">
                <span>{eventName(r.name)}</span>
                <span className="tabular-nums text-muted-foreground">{formatCount(r.count)}</span>
              </div>
              <div className="h-1 rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/65"
                  style={{ width: `${(r.count / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No events in this period.</p>
      )}
    </section>
  );
}
