import type { ThreadListed } from "../api";
import type { ThreadList, ThreadRow } from "../store";
import { byRecency, cursorPosition, foldTitle } from "./layout";

/**
 * Keeping paged lists whole: a refresh of a space's first pages merged into
 * what is loaded, and the filter's results narrowed without asking the core
 * again. Plain data, so it is tested in Node (paging.test.ts).
 */

/** One space's matches from the core for the filter, page by page. */
export type FilterList = { items: ThreadRow[]; total?: number; hasMore: boolean; cursor: string | null; loading: boolean; loadingMore: boolean; error?: string };

const sortRows = (rows: ThreadRow[]) => [...rows].sort(byRecency);

/** Whether `t` comes after position `c` in the core's order (newest first, ties by id, highest first). */
const pastCursor = (t: { updated: number; id: string }, c: { updated: number; id: string }) => t.updated < c.updated || (t.updated === c.updated && t.id < c.id);

/**
 * A refresh's first page merged into what is listed. Rows the UI added and
 * the core doesn't list yet stay. When more was loaded than the refresh
 * reloads (it reloads at most a few hundred), the loaded rows past its end
 * stay too, and paging goes on from where it had got to, so a refresh never
 * shortens a list someone scrolled far into.
 */
export function mergeRefresh(cur: ThreadList, page: { items: ThreadListed[]; hasMore: boolean; nextCursor: string | null }): Pick<ThreadList, "data" | "hasMore" | "cursor"> {
  const rows = cur.data ?? [];
  const listed = new Set(page.items.map((t) => t.id));
  const added = rows.filter((t) => t.optimistic && !listed.has(t.id));
  const end = page.hasMore ? cursorPosition(page.nextCursor) : null;
  // How far the list had been loaded: to its cursor, or to the end.
  const loadedAll = !!cur.data && cur.hasMore === false;
  const had = loadedAll ? null : cursorPosition(cur.cursor);
  if (end && (loadedAll || (had && pastCursor(had, end)))) {
    const older = rows.filter((t) => !t.optimistic && !t.pinned && !listed.has(t.id) && pastCursor(t, end));
    return { data: sortRows([...added, ...page.items, ...older]), hasMore: !loadedAll, cursor: loadedAll ? null : cur.cursor };
  }
  return { data: sortRows([...added, ...page.items]), hasMore: page.hasMore, cursor: page.nextCursor };
}

/**
 * Each space's results the moment the query changes, before the core answers:
 * a narrowed query over a complete answer is that answer filtered (done);
 * otherwise the last answer stays, for the list to re-filter at once, marked
 * as loading until the new one arrives.
 */
export function nextResults(prev: Record<string, FilterList>, spaces: readonly string[], prevQuery: string, query: string): Record<string, FilterList> {
  const narrows = !!prevQuery && query.includes(prevQuery);
  return Object.fromEntries(
    spaces.map((id) => {
      const p = prev[id];
      if (narrows && p && !p.loading && !p.hasMore && !p.error) {
        const items = p.items.filter((t) => foldTitle(t.title).includes(query));
        return [id, { ...p, items, total: items.length, loadingMore: false }];
      }
      return [id, { ...(p ?? { items: [], hasMore: false, cursor: null, loadingMore: false }), loading: true }];
    }),
  );
}

