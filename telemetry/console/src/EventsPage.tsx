import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CATEGORY_LABELS,
  TELEMETRY_CATEGORIES,
  type EventPage,
  type EventSummary,
  type TelemetryCategory,
} from "./api";
import { EventDetail } from "./EventDetail";
import { EventList } from "./EventList";
import { FilterSelect } from "./FilterSelect";
import { TableSkeleton } from "./Loading";

const CATEGORY_OPTIONS = [
  { value: "all", label: "All categories" },
  ...TELEMETRY_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
];

const matches = (event: EventSummary, search: string) =>
  `${event.event} ${event.platform} ${event.appVersion}`.toLowerCase().includes(search.toLowerCase());

export function EventsPage({
  busy,
  events,
  category,
  onCategoryChange,
  search,
  onSearchChange,
  selected,
  onSelect,
  loadingMore,
  onLoadMore,
  exporting,
  onExport,
  onExpired,
}: {
  busy: boolean;
  events: EventPage | null;
  category: TelemetryCategory | "";
  onCategoryChange: (category: TelemetryCategory | "") => void;
  search: string;
  onSearchChange: (search: string) => void;
  selected: EventSummary | null;
  onSelect: (event: EventSummary | null) => void;
  loadingMore: boolean;
  onLoadMore: () => void;
  exporting: boolean;
  onExport: () => void;
  onExpired: () => void;
}) {
  const visible = events?.items.filter((event) => matches(event, search)) ?? [];
  return (
    <>
      <section className="min-w-0" aria-busy={busy}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">Shared events</h2>
          <Button
            size="sm"
            variant="outline"
            pending={exporting}
            disabled={exporting || !events}
            onClick={onExport}
          >
            <Icon icon={icons.download} className="size-3.5" />
            Export NDJSON
          </Button>
        </div>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <FilterSelect
            label="Event category"
            value={category || "all"}
            onChange={(value) => onCategoryChange(value === "all" ? "" : (value as TelemetryCategory))}
            options={CATEGORY_OPTIONS}
            className="w-44"
          />
          <Input
            type="search"
            aria-label="Filter loaded events"
            placeholder="Search loaded events…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="max-w-72"
          />
        </div>
        {!events && busy ? <TableSkeleton /> : null}
        {events ? (
          <>
            <EventList
              items={visible}
              selectedId={selected?.id}
              onOpen={onSelect}
              showEmpty={!busy && !visible.length}
              filtered={search !== ""}
            />
            {events.nextCursor ? (
              <div className="mt-3 flex justify-center">
                <Button
                  size="sm"
                  variant="outline"
                  pending={loadingMore}
                  disabled={loadingMore}
                  onClick={onLoadMore}
                >
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
      {selected ? (
        <EventDetail key={selected.id} item={selected} onClose={() => onSelect(null)} onExpired={onExpired} />
      ) : null}
    </>
  );
}
