import { isValidThreadId } from "../core/thread.ts";

/**
 * One page of a space's conversation list. The list is ordered newest first
 * (by `updated`, then id, as `listThreadsIn` gives it); pinned conversations
 * all come first on the first page, oldest pin first, and never on a later
 * one. `limit` counts the unpinned ones. A cursor names the last unpinned
 * conversation a page ended with as `<updated>:<id>`, so the next page starts
 * right after it even when conversations above it changed meanwhile.
 */

export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 500;

export type PageArgs = { limit?: unknown; before?: unknown; query?: unknown };
export type Page<T> = { items: T[]; total: number; hasMore: boolean; nextCursor: string | null };

type Listed = { id: string; title: string; updated: number; pinned?: number };

/** Whether a call asked for a page (any paging argument given) rather than the whole list. */
export function wantsPage(args: PageArgs): boolean {
  return args.limit !== undefined || args.before !== undefined || args.query !== undefined;
}

export const cursorOf = (t: { updated: number; id: string }) => `${t.updated}:${t.id}`;

/** A cursor's position; null when it isn't one. */
export function parseCursor(v: unknown): { updated: number; id: string } | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,16}):(.+)$/.exec(v);
  if (!m || !isValidThreadId(m[2])) return null;
  return { updated: Number(m[1]), id: m[2] };
}

/** Lower-case, one space between words, so "Week  6" finds "week 6". */
export function foldTitle(s: string): string {
  return s.normalize("NFKC").toLocaleLowerCase().split(/\p{White_Space}+/u).filter(Boolean).join(" ");
}

/** Comes after `c` in newest-first order. */
const after = (t: Listed, c: { updated: number; id: string }) => t.updated < c.updated || (t.updated === c.updated && t.id < c.id);

/** Validated paging arguments, or a message to show for ones that aren't. */
export function pageArgs(args: PageArgs): { limit: number; before: { updated: number; id: string } | null; query: string } | string {
  let limit = PAGE_DEFAULT;
  if (args.limit !== undefined && args.limit !== null) {
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1) return "A page size has to be a whole number above zero.";
    limit = Math.min(args.limit, PAGE_MAX);
  }
  let before = null;
  if (args.before !== undefined && args.before !== null && args.before !== "") {
    before = parseCursor(args.before);
    if (!before) return "That place in the list isn’t one Phaethon knows. Reload the list and try again.";
  }
  if (args.query !== undefined && args.query !== null && typeof args.query !== "string") return "A search has to be text.";
  return { limit, before, query: typeof args.query === "string" ? foldTitle(args.query) : "" };
}

/** One page of `list` (already newest first). */
export function pageOf<T extends Listed>(list: T[], opts: { limit: number; before: { updated: number; id: string } | null; query: string }): Page<T> {
  const matching = opts.query ? list.filter((t) => foldTitle(t.title).includes(opts.query)) : list;
  const pinned = matching.filter((t) => t.pinned).sort((a, b) => a.pinned! - b.pinned! || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let rest = matching.filter((t) => !t.pinned);
  if (opts.before) {
    const c = opts.before;
    rest = rest.filter((t) => after(t, c));
  }
  const shown = rest.slice(0, opts.limit);
  const hasMore = rest.length > shown.length;
  const last = shown[shown.length - 1];
  return {
    items: opts.before ? shown : [...pinned, ...shown],
    total: matching.length,
    hasMore,
    nextCursor: hasMore && last ? cursorOf(last) : null,
  };
}
