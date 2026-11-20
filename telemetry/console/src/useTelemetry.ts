import { useEffect, useRef, useState } from "react";
import {
  errorMessage,
  request,
  SessionExpired,
  type EventPage,
  type Overview,
  type TelemetryCategory,
} from "./api";

const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
const LOAD_FAILED = "Couldn’t load telemetry. Try again.";

type Query = { days: number; category: TelemetryCategory | ""; refresh: number; onExpired: () => void };

const queryString = (days: number, category: TelemetryCategory | "") =>
  new URLSearchParams({ days: String(days), ...(category ? { category } : {}) }).toString();

/**
 * Loads the overview and the first page of events for a period and category, plus "load more" and
 * NDJSON export over the same query. Results are cached per query for the life of the session.
 */
export function useTelemetry({ days, category, refresh, onExpired }: Query) {
  const cache = useRef(new Map<string, { overview: Overview; events: EventPage }>());
  const [overview, setOverview] = useState<Overview | null>(null);
  const [events, setEvents] = useState<EventPage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Bumped per query so a page that arrives after the query changed is dropped.
  const generation = useRef(0);
  const pageRequest = useRef<AbortController | null>(null);
  const exportRequest = useRef<AbortController | null>(null);
  const query = queryString(days, category);

  const fail = (controller: AbortController, e: unknown) => {
    if (controller.signal.aborted) return;
    if (e instanceof SessionExpired) onExpired();
    else setError(errorMessage(e, LOAD_FAILED));
  };

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const key = `${days}:${category}`;
    const cached = cache.current.get(key);
    generation.current++;
    setBusy(true);
    setLoadingMore(false);
    setError("");
    setEvents(cached?.events ?? null);
    setOverview(cached?.overview ?? null);
    Promise.all([
      request<Overview>(`/overview?days=${days}`, { signal }),
      request<EventPage>(`/events?${queryString(days, category)}`, { signal }),
    ])
      .then(([overview, events]) => {
        if (signal.aborted) return;
        cache.current.set(key, { overview, events });
        setOverview(overview);
        setEvents(events);
      })
      .catch((e) => fail(controller, e))
      .finally(() => {
        if (!signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      pageRequest.current?.abort();
    };
  }, [days, category, refresh, onExpired]);

  useEffect(() => () => exportRequest.current?.abort(), []);

  const loadMore = async () => {
    if (!events?.nextCursor || loadingMore) return;
    const started = generation.current;
    const controller = new AbortController();
    pageRequest.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const before = encodeURIComponent(events.nextCursor);
      const next = await request<EventPage>(`/events?${query}&before=${before}`, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted && started === generation.current) {
        setEvents((old) => ({ items: [...(old?.items ?? []), ...next.items], nextCursor: next.nextCursor }));
      }
    } catch (e) {
      fail(controller, e);
    } finally {
      if (started === generation.current) setLoadingMore(false);
    }
  };

  const exportEvents = async () => {
    const controller = new AbortController();
    exportRequest.current = controller;
    setExporting(true);
    setError("");
    try {
      const chunks = await downloadExport(query, controller.signal);
      if (chunks === "expired") return onExpired();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob(chunks, { type: "application/x-ndjson" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `phaethon-telemetry-${category || "all"}-${days}d.ndjson`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e, LOAD_FAILED));
    } finally {
      setExporting(false);
      exportRequest.current = null;
    }
  };

  return {
    overview,
    events,
    error,
    busy,
    loadingMore,
    exporting,
    loadMore,
    exportEvents,
    cancelExport: () => exportRequest.current?.abort(),
    cancelPending: () => {
      exportRequest.current?.abort();
      pageRequest.current?.abort();
    },
  };
}

/** Follows the export's cursor header page by page until the server has sent everything. */
async function downloadExport(query: string, signal: AbortSignal): Promise<Blob[] | "expired"> {
  const chunks: Blob[] = [];
  const visited = new Set<string>();
  let cursor = "";
  let bytes = 0;
  do {
    if (visited.has(cursor)) throw new Error("Couldn’t complete the export. Try again.");
    visited.add(cursor);
    const before = cursor ? `&before=${encodeURIComponent(cursor)}` : "";
    const response = await fetch(`/api/export?${query}${before}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (response.status === 401) return "expired";
    if (!response.ok) throw new Error("Couldn’t export events. Try again.");
    const chunk = await response.blob();
    bytes += chunk.size;
    if (bytes > MAX_EXPORT_BYTES) {
      throw new Error("This export exceeds 50 MB. Choose a shorter period or one category.");
    }
    chunks.push(chunk);
    cursor = response.headers.get("X-Next-Cursor") ?? "";
  } while (cursor && !signal.aborted);
  return chunks;
}
