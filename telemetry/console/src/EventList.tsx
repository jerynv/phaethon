import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { CATEGORY_LABELS, eventName, formatDate, type EventSummary } from "./api";

const COLUMNS = ["Event", "Category", "Received", "Version", "Platform"];

/** Events as a table from the `sm` breakpoint up, and as a list of cards below it. */
export function EventList({
  items,
  selectedId,
  onOpen,
  showEmpty,
  filtered,
}: {
  items: EventSummary[];
  selectedId: string | undefined;
  onOpen: (event: EventSummary) => void;
  showEmpty: boolean;
  /** Whether a search narrowed the list, which changes what an empty list means. */
  filtered: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-card border bg-card">
      <table className="hidden w-full text-left text-sm sm:table">
        <caption className="sr-only">Shared telemetry events</caption>
        <thead className="border-b bg-well text-xs text-muted-foreground">
          <tr>
            {COLUMNS.map((heading) => (
              <th scope="col" key={heading} className="whitespace-nowrap px-4 py-2 font-normal">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((event) => (
            <tr key={event.id} className={selectedId === event.id ? "bg-accent" : ""}>
              <td className="px-4 py-3">
                <button
                  className="text-left font-medium outline-none hover:text-primary focus-visible:underline"
                  onClick={() => onOpen(event)}
                >
                  {eventName(event.event)}
                </button>
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                {CATEGORY_LABELS[event.category]}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                {formatDate(event.receivedAt)}
              </td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{event.appVersion}</td>
              <td className="px-4 py-3 text-xs text-muted-foreground">{event.platform}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="divide-y sm:hidden" aria-label="Shared telemetry events">
        {items.map((event) => (
          <li key={event.id}>
            <button
              onClick={() => onOpen(event)}
              className="flex w-full cursor-pointer flex-col gap-2 p-4 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="flex w-full items-center justify-between gap-3">
                <span className="text-sm font-medium">{eventName(event.event)}</span>
                <span className="text-xs text-muted-foreground">{CATEGORY_LABELS[event.category]}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {formatDate(event.receivedAt)} · {event.platform} · {event.appVersion}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {showEmpty ? <EmptyEvents filtered={filtered} /> : null}
    </div>
  );
}

function EmptyEvents({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
      <Icon icon={icons.fileText} className="size-6 text-muted-foreground/60" />
      <p className="text-sm">
        {filtered ? "No loaded events match this filter." : "No shared events in this period."}
      </p>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
        {filtered
          ? "Try a different event name, version, or platform."
          : "Events appear here after someone saves their privacy choices and shares activity."}
      </p>
    </div>
  );
}
