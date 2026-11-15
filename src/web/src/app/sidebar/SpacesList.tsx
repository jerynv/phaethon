import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { RowError } from "@/components/errors";
import { TruncateTips } from "@/components/truncate";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "@/components/ui/menu";
import { SidebarContent, SidebarMenuSkeleton } from "@/components/ui/sidebar";
import type { SpaceView } from "../api";
import { DRAFT, THREAD_PAGE, useNav, type ThreadList, type ThreadRow } from "../store";
import type { ThreadFilter } from "./filter";
import { foldTitle, LABEL, layoutSpaces, revealOffset, ROW, STICKY, threadKey, type Item, type Layout, type SpaceInput } from "./layout";
import { ListContext, type ListContextValue } from "./list-context";
import { LoaderRow, RowSlot, ThreadMenuItems, type LoaderMode } from "./rows";
import { SpaceHeader, SpaceMenuItems } from "./space-header";

/**
 * Every space and its conversations as one windowed list: only the rows on
 * screen (plus a few either side) exist, however many conversations there
 * are. @tanstack/react-virtual picks the range over the fixed-height layout
 * from ./layout.ts; this places each space in view as a section with its
 * sticky row, each group in view with its sticky label, and the rows in view
 * inside them.
 *
 * Paging: the skeleton row at the end of a space's loaded run asks for the
 * next page while it is within two screens below the view. A space with more
 * spaces below it loads a share of pages on its own, then offers "Show older",
 * so scrolling on reaches the next space. Keyboard: arrows, Home and End move
 * through space rows and conversations, scrolling as they go; the focused
 * row, one being renamed and one with its menu open stay rendered while they
 * scroll away. The open conversation scrolls into view when it changes (from
 * search, or on start), once it is listed.
 *
 * Nothing on screen moves when the list changes elsewhere: before each change
 * the list notes the focused row, else the open one, else the first rows in
 * view, and after it scrolls so that row stays where it was (a row that itself
 * moved or went is passed over for the next).
 */

/** Pages a space loads on its own as it scrolls before it offers "Show older" (only when another space follows it). */
export const AUTO_PAGES = 4;

/** What a row's place depends on: when this changes the row itself moved, so it can't hold the view still. */
const placeKey = (it: Item) => (it.kind === "row" ? `${it.thread!.pinned ?? ""}:${it.thread!.updated}` : it.kind);

/** The first item whose bottom is below `y` (items are in order, back to back). */
function firstBelow(items: readonly Item[], y: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid]!.start + items[mid]!.size <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A row's title tooltip sits beside the whole row, clear of its "…". */
const tipAnchor = (title: HTMLElement) => title.closest("[data-slot=sidebar-menu-item]");

type Anchor = { top: number; marks: Array<{ key: string; offset: number; place: string }> };
type Ghost = { item: Item; block: string; y: number };

/** Local midnight today, moving on when the day does (the groups are relative to it). */
function useToday(): number {
  const midnight = () => new Date().setHours(0, 0, 0, 0);
  const [today, setToday] = useState(midnight);
  useEffect(() => {
    const check = () => setToday((t) => (midnight() === t ? t : midnight()));
    const id = setInterval(check, 60_000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", check);
    };
  }, []);
  return today;
}

const NO_ROWS: ThreadRow[] = [];

/** Rows by id, the first of each kept. */
function unique(rows: ThreadRow[]): ThreadRow[] {
  const seen = new Set<string>();
  return rows.filter((t) => !seen.has(t.id) && !!seen.add(t.id));
}

/** Reports `value` while mounted (inside a menu's popup: which row it is open for). */
function OpenFor({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  useEffect(() => {
    onChange(value);
    return () => onChange(null);
  }, [value, onChange]);
  return null;
}

/** The menu for the row or space row `key` (the "…" menu and the right-click menu share it). */
function ItemMenu({ itemKey, layout, spaces, context }: { itemKey: string; layout: Layout; spaces: SpaceView[]; context: boolean }) {
  const i = layout.index.get(itemKey);
  const it = i === undefined ? undefined : layout.items[i];
  const Item = context ? ContextMenuItem : MenuItem;
  const Separator = context ? ContextMenuSeparator : MenuSeparator;
  if (it?.kind === "row") return <ThreadMenuItems itemKey={itemKey} space={it.space} thread={it.thread!} Item={Item} Separator={Separator} />;
  const space = it?.kind === "space" ? spaces.find((s) => s.id === it.space) : undefined;
  return space ? <SpaceMenuItems space={space} Item={Item} /> : null;
}

export type SpacesListHandle = {
  focusFirst(rowsOnly?: boolean): void;
  openFirst(): void;
  /** After a delete: focuses what now sits where the deleted row was. False when there is nothing to focus. */
  focusDeleted(): boolean;
};

export function SpacesList({
  spaces,
  query,
  filter,
  onDelete,
  onExitTop,
  ref,
}: {
  spaces: SpaceView[];
  /** The filter's text, folded; empty when not filtering. */
  query: string;
  filter: ThreadFilter;
  onDelete: (space: string, t: ThreadRow) => void;
  /** Up from the first row. */
  onExitTop: () => void;
  ref?: Ref<SpacesListHandle>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const threads = useNav((s) => s.threads);
  const collapsed = useNav((s) => s.collapsed);
  const activeSpace = useNav((s) => s.activeSpace);
  const view = useNav((s) => s.view);
  const settingsOpen = useNav((s) => s.settings !== null);
  const open = useNav((s) => s.open);
  const loadThreads = useNav((s) => s.loadThreads);
  const loadMoreThreads = useNav((s) => s.loadMoreThreads);
  const today = useToday();
  const filtering = !!query;

  // ---- What is listed: each space's rows (filtered while the filter has text), then the layout.
  /** The spaces the last render listed. */
  const shownRef = useRef(new Set<string>());
  const inputs = useMemo(() => {
    const out: Array<SpaceInput & { count: number }> = [];
    for (const sp of spaces) {
      const list: ThreadList | undefined = threads[sp.id];
      const data = list?.data ?? NO_ROWS;
      if (!filtering) {
        // Only the loaded pages are listed; the core's total counts the rest (rows the UI added itself aren't in it yet).
        const added = data.reduce((n, t) => n + (t.optimistic ? 1 : 0), 0);
        out.push({
          id: sp.id,
          collapsed: !!collapsed[sp.id],
          status: list?.data ? "ready" : list?.error ? "error" : "loading",
          rows: data,
          hasMore: !!list?.hasMore,
          cursor: list?.cursor ?? null,
          empty: "No conversations yet",
          count: Math.max(data.length, (list?.total ?? 0) + added),
        });
        continue;
      }
      // Filtering: what is loaded and matches, with the core's matches from further back (the loaded copy of a row wins).
      const match = (t: ThreadRow) => foldTitle(t.title).includes(query);
      const local = data.filter(match);
      if (list?.data && !list.hasMore) {
        // Every conversation is loaded: the answer is here already (and a space with none drops out at once).
        if (local.length) out.push({ id: sp.id, collapsed: false, status: "ready", rows: local, hasMore: false, cursor: null, empty: "No matches", count: local.length });
        continue;
      }
      const found = filter.results[sp.id];
      const byId = new Map(data.map((t) => [t.id, t]));
      const rows = unique([...local, ...(found?.items ?? NO_ROWS).map((t) => byId.get(t.id) ?? t).filter(match)]);
      const loading = !found || found.loading;
      const hasMore = !!found && !found.loading && found.hasMore;
      // A space with nothing matching drops out of the list; one already out stays out while the core answers.
      if (!rows.length && !hasMore && (!loading || !shownRef.current.has(sp.id))) continue;
      out.push({
        id: sp.id,
        collapsed: false,
        status: rows.length ? "ready" : loading ? "loading" : found?.error ? "error" : "ready",
        rows,
        hasMore,
        cursor: found?.cursor ?? null,
        empty: "No matches",
        // While the core answers, the rows listed (its last total was for another query).
        count: loading ? rows.length : Math.max(rows.length, found?.total ?? 0),
      });
    }
    return out;
  }, [spaces, threads, collapsed, filtering, query, filter.results]);
  useEffect(() => {
    shownRef.current = new Set(inputs.map((i) => i.id));
  }, [inputs]);
  const layout = useMemo(() => layoutSpaces(inputs, today), [inputs, today]);
  const { items, sections } = layout;
  const spaceById = useMemo(() => new Map(spaces.map((s, i) => [s.id, { space: s, index: i }])), [spaces]);

  // ---- The shared menus: one "…" menu for every row, one right-click menu for the whole list.
  const rowMenu = useMemo(() => MenuPrimitive.createHandle<string>(), []);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [contextFor, setContextFor] = useState<string | null>(null);
  const contextTarget = useRef<string | null>(null);
  const lastContext = useRef<string | null>(null);
  if (contextFor) lastContext.current = contextFor;

  // ---- Rows that stay rendered while they scroll away: focused, being renamed, a menu open, about to be focused.
  const [focused, setFocused] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [focusTo, setFocusTo] = useState<string | null>(null);
  const focusToRef = useRef(focusTo);
  focusToRef.current = focusTo;
  const keepKeys = useMemo(() => [focused, renaming, focusTo, menuFor, contextFor].filter((k): k is string => !!k), [focused, renaming, focusTo, menuFor, contextFor]);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const out = new Set(defaultRangeExtractor(range));
      for (const k of keepKeys) {
        const i = layout.index.get(k);
        if (i !== undefined) out.add(i);
      }
      return [...out].sort((a, b) => a - b);
    },
    [keepKeys, layout],
  );
  // A new key function per layout makes the virtualizer measure again (its sizes are the layout's).
  const getItemKey = useCallback((i: number) => layout.items[i]?.key ?? i, [layout]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => items[i]?.size ?? ROW,
    getItemKey,
    overscan: 8,
    rangeExtractor,
  });
  const rendered = virtualizer.getVirtualItems();

  // ---- Nothing slides or fades while the filter swaps the list, or when a page (or a reload) arrives.
  const [instant, setInstant] = useState(false);
  const [shownQuery, setShownQuery] = useState(query);
  const pages = inputs.map((i) => `${i.id}:${i.status}:${i.cursor}:${i.hasMore}`).join("|");
  const [shownPages, setShownPages] = useState(pages);
  if (shownQuery !== query || shownPages !== pages) {
    setShownQuery(query);
    setShownPages(pages);
    setInstant(true);
  }
  useEffect(() => {
    if (!instant) return;
    let b = 0;
    const a = requestAnimationFrame(() => (b = requestAnimationFrame(() => setInstant(false))));
    return () => {
      cancelAnimationFrame(a);
      cancelAnimationFrame(b);
    };
  }, [instant]);

  // ---- Fresh rows: new to the list, or moved to another group, since the last layout (not on a space's first load, not while filtering).
  const placeOf = useCallback((it: Item) => `${it.space}:${sections[it.section]?.blocks[it.group]?.key}`, [sections]);
  const placed = useRef<Map<string, string> | null>(null);
  const seenSpaces = useRef(new Set<string>());
  useEffect(() => {
    const m = new Map<string, string>();
    for (const it of items) {
      if (it.kind !== "row") continue;
      m.set(it.key, placeOf(it));
      seenSpaces.current.add(it.space);
    }
    placed.current = m;
  }, [items, placeOf]);
  const isFresh = (it: Item) => !!placed.current && !filtering && !instant && seenSpaces.current.has(it.space) && placed.current.get(it.key) !== placeOf(it);

  // ---- Paging: a loader within two screens below the view asks for the next page.
  const [moreFailed, setMoreFailed] = useState<Record<string, true>>({});
  /** "Show older" presses per space: each lets it load another share of pages on its own. */
  const [shares, setShares] = useState<Record<string, number>>({});
  const loaderMode = (si: number): LoaderMode => {
    const input = inputs[si]!;
    if (moreFailed[input.id]) return "failed";
    const capped = si < inputs.length - 1 && input.rows.length >= THREAD_PAGE * (1 + AUTO_PAGES * (1 + (shares[input.id] ?? 0)));
    return capped ? "more" : "loading";
  };
  const inFlight = useRef(new Set<string>());
  const [, setSettled] = useState(0);
  const canLoad = (space: string) => {
    if (filtering) {
      const f = filter.results[space];
      return !!f && !f.loading && !f.loadingMore && f.hasMore && !!f.cursor;
    }
    const l = threads[space];
    return !!l && !!l.hasMore && !!l.cursor && !l.loading && !l.loadingMore;
  };
  const requestMore = (space: string) => {
    if (inFlight.current.has(space) || moreFailed[space] || !canLoad(space)) return;
    inFlight.current.add(space);
    const run = filtering ? filter.loadMore(space) : loadMoreThreads(space);
    run.then(
      () => {
        inFlight.current.delete(space);
        // Looks again: a loader still within reach (a tall window) loads the next page without waiting for a scroll.
        setSettled((n) => n + 1);
      },
      () => {
        inFlight.current.delete(space);
        setMoreFailed((f) => ({ ...f, [space]: true }));
      },
    );
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const reach = top + 2 * el.clientHeight;
    sections.forEach((sec, si) => {
      const i = layout.index.get(`loader:${sec.space}`);
      const it = i === undefined ? undefined : items[i];
      // One above the view (pushed up while a row below it held still) waits until it is scrolled back to.
      if (it && it.start + it.size > top && it.start < reach && loaderMode(si) === "loading") requestMore(sec.space);
    });
  });
  // A reload starts the space's pages over; a failed page gets another go.
  useEffect(() => {
    setMoreFailed((f) => (Object.keys(f).some((s) => threads[s]?.loading) ? Object.fromEntries(Object.entries(f).filter(([s]) => !threads[s]?.loading)) : f));
  }, [threads]);

  // ---- Holding the view still: the rows on screen stay where they are when something above them changes.
  const anchor = useRef<Anchor | null>(null);
  const anchoredLayout = useRef(layout);
  const holdTimer = useRef(0);
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scrollRef.current;
    if (anchoredLayout.current === layout || !a || !el) {
      anchoredLayout.current = layout;
      return;
    }
    anchoredLayout.current = layout;
    for (const m of a.marks) {
      const i = layout.index.get(m.key);
      if (i === undefined || placeKey(items[i]!) !== m.place) continue;
      const to = Math.max(0, items[i]!.start - m.offset);
      if (to !== el.scrollTop) {
        el.scrollTop = to;
        // What the scroll makes up for doesn't slide as well.
        const box = el.querySelector<HTMLElement>("[data-slot=sidebar-spaces]");
        box?.setAttribute("data-hold", "");
        cancelAnimationFrame(holdTimer.current);
        holdTimer.current = requestAnimationFrame(() => (holdTimer.current = requestAnimationFrame(() => box?.removeAttribute("data-hold"))));
      }
      break;
    }
  }, [layout, items]);

  // ---- A space folded while scrolled into it keeps its row where it was, at the top, instead of the list jumping to the next space.
  const lastCollapsed = useRef(collapsed);
  useLayoutEffect(() => {
    const before = lastCollapsed.current;
    lastCollapsed.current = collapsed;
    const el = scrollRef.current;
    if (!el || before === collapsed) return;
    for (const sec of sections) {
      if (!!before[sec.space] !== !!collapsed[sec.space] && sec.start < el.scrollTop) el.scrollTop = sec.start;
    }
  }, [collapsed, sections]);

  // ---- The open conversation scrolls into view when it changes (opened from search, or on start), once it is listed.
  const chatSpace = !settingsOpen && view === "chat" ? activeSpace : null;
  const openId = chatSpace ? open[chatSpace] : undefined;
  const target = chatSpace && openId && openId !== DRAFT ? threadKey(chatSpace, openId) : null;
  const lastTarget = useRef<string | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const pending = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (target !== lastTarget.current) {
      lastTarget.current = target;
      pending.current = target;
    }
    const k = pending.current;
    const el = scrollRef.current;
    if (!k || !el || !chatSpace) return;
    let i = layout.index.get(k);
    // Folded away, the space's own row stands in for it.
    if (i === undefined && collapsed[chatSpace] && !filtering) i = layout.index.get(`space:${chatSpace}`);
    if (i === undefined) return;
    pending.current = null;
    const off = revealOffset(items[i]!, el.scrollTop, el.clientHeight);
    if (off !== null) el.scrollTop = off;
  }, [target, layout, items, chatSpace, collapsed, filtering]);

  // ---- A new filter starts at the top; clearing it goes back to the open conversation.
  const lastQuery = useRef(query);
  useLayoutEffect(() => {
    if (lastQuery.current === query) return;
    lastQuery.current = query;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
    const i = !query && target ? layout.index.get(target) : undefined;
    const off = i === undefined ? null : revealOffset(items[i]!, 0, el.clientHeight);
    if (off !== null) el.scrollTop = off;
  }, [query, target, layout, items]);

  // ---- Keyboard: arrows move through space rows and conversations, scrolling as they go.
  const focusItem = useCallback(
    (i: number) => {
      const it = items[i];
      const el = scrollRef.current;
      if (!it || !el) return;
      const off = revealOffset(it, el.scrollTop, el.clientHeight);
      if (off !== null) el.scrollTop = off;
      setFocusTo(it.key);
    },
    [items],
  );
  const focusItemRef = useRef(focusItem);
  focusItemRef.current = focusItem;
  useLayoutEffect(() => {
    if (!focusTo) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-item-key="${CSS.escape(focusTo)}"] [data-nav-row]`);
    if (el) el.focus({ preventScroll: true });
    setFocusTo(null);
  }, [focusTo]);
  /** Space rows, conversations, and a "Show older" row. */
  const focusable = (it: Item | undefined) => it?.kind === "space" || it?.kind === "row" || (it?.kind === "loader" && loaderMode(it.section) === "more");
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const key = (e.target as HTMLElement).closest<HTMLElement>("[data-item-key]")?.dataset.itemKey;
    const at = key ? layout.index.get(key) : undefined;
    if (at === undefined) return;
    e.preventDefault();
    let next = -1;
    if (e.key === "Home") next = items.findIndex(focusable);
    else if (e.key === "End") next = items.findLastIndex(focusable);
    else if (e.key === "ArrowDown") next = items.findIndex((it, i) => i > at && focusable(it));
    else {
      next = items.findLastIndex((it, i) => i < at && focusable(it));
      if (next === -1) return onExitTop();
    }
    if (next !== -1) focusItem(next);
  };
  useImperativeHandle(ref, () => ({
    focusFirst(rowsOnly) {
      const i = items.findIndex((it) => (rowsOnly ? it.kind === "row" : it.kind === "row" || it.kind === "space"));
      if (i !== -1) focusItem(i);
    },
    openFirst() {
      const it = items.find((x) => x.kind === "row");
      if (!it?.thread) return;
      useNav.getState().ensureThread(it.space, it.thread);
      void useNav.getState().openThread(it.space, it.thread.id);
    },
    focusDeleted() {
      const at = deletedAt.current;
      deletedAt.current = null;
      if (at === null) return false;
      let i = items.findIndex((it, j) => j >= at && focusable(it));
      if (i === -1) i = items.findLastIndex(focusable);
      if (i === -1) return false;
      focusItem(i);
      return true;
    },
  }));

  // ---- Shared with rows, stable for the list's life.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  /** Where the row asked to be deleted sat, for `focusDeleted`. */
  const deletedAt = useRef<number | null>(null);
  const ctx = useMemo<ListContextValue>(
    () => ({
      onDelete: (space, t) => {
        deletedAt.current = layoutRef.current.index.get(threadKey(space, t.id)) ?? null;
        onDeleteRef.current(space, t);
      },
      rename: setRenaming,
      retryMore: (space) => setMoreFailed(({ [space]: _, ...rest }) => rest),
      showOlder: (space) => {
        // The button turns back into a skeleton: focus steps up to the last row above it, for ↓ to carry on into the new ones.
        const L = layoutRef.current;
        const at = L.index.get(`loader:${space}`);
        const active = document.activeElement;
        if (at !== undefined && active?.closest(`[data-item-key="loader:${CSS.escape(space)}"]`)) {
          const prev = L.items.findLastIndex((it, i) => i < at && it.kind === "row");
          if (prev !== -1) focusItemRef.current(prev);
        }
        setShares((s) => ({ ...s, [space]: (s[space] ?? 0) + 1 }));
      },
      rowMenu,
    }),
    [rowMenu],
  );

  // ---- Deleted rows fade out where they were for a moment; rows scrolling out or swapped by the filter just go.
  const [ghosts, setGhosts] = useState<Record<string, Ghost>>({});
  /** The rows the last commit rendered, and the ones this render does. */
  const lastRows = useRef(new Map<string, Ghost>());
  const rowsNowRef = useRef(lastRows.current);
  const ghostLayout = useRef(layout);
  useLayoutEffect(() => {
    if (ghostLayout.current === layout) return;
    ghostLayout.current = layout;
    if (instant) return;
    const gone: Record<string, Ghost> = {};
    for (const [k, g] of lastRows.current) if (!layout.index.has(k)) gone[k] = g;
    const keys = Object.keys(gone);
    if (!keys.length) return;
    setGhosts((cur) => ({ ...cur, ...gone }));
    // Not cleared by the next change: a ghost always goes after its fade.
    setTimeout(() => setGhosts((cur) => Object.fromEntries(Object.entries(cur).filter(([k]) => !keys.includes(k)))), 160);
  }, [layout, instant]);
  useLayoutEffect(() => {
    lastRows.current = rowsNowRef.current;
  });

  // ---- The title tooltip shared by every row: shut while a menu is open, closed when the list scrolls.
  const hideTip = useRef<(() => void) | null>(null);

  // ---- Noting what holds the view still (on each scroll, and after each change): the focused row, the open one, the first rows in view.
  const captureAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const L = layoutRef.current;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;
    const marks: Anchor["marks"] = [];
    const mark = (i: number | undefined) => {
      const it = i === undefined ? undefined : L.items[i];
      if (it) marks.push({ key: it.key, offset: it.start - top, place: placeKey(it) });
    };
    const near = (i: number | undefined) => i !== undefined && L.items[i]!.start + L.items[i]!.size > top && L.items[i]!.start < bottom;
    const active = document.activeElement;
    const focusedKey = focusToRef.current ?? (active && el.contains(active) ? active.closest<HTMLElement>("[data-item-key]")?.dataset.itemKey : undefined);
    const fi = focusedKey ? L.index.get(focusedKey) : undefined;
    if (near(fi)) mark(fi);
    // At the very top nothing else holds: what is added above shows.
    if (top > 0) {
      const ti = targetRef.current ? L.index.get(targetRef.current) : undefined;
      if (near(ti)) mark(ti);
      for (let i = firstBelow(L.items, top + STICKY); i < L.items.length && L.items[i]!.start < bottom && marks.length < 24; i++) {
        const it = L.items[i]!;
        if ((it.kind === "row" || it.kind === "space") && it.start >= top + STICKY && it.start + it.size <= bottom) mark(i);
      }
    }
    anchor.current = { top, marks };
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      captureAnchor();
      hideTip.current?.();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [captureAnchor]);
  useLayoutEffect(() => captureAnchor());

  // ---- Render: each space in view as a section (its sticky row, then its groups in view, each with a sticky label and its rows in view).
  // Sections and groups are placed with `top`, not a transform: a sticky row inside works from layout positions, and a transform would leave it behind.
  // Rows hold nothing sticky and use transforms.
  const shown = new Map<number, Map<number, Item[]>>();
  for (const v of rendered) {
    const it = items[v.index];
    if (!it) continue;
    let blocks = shown.get(it.section);
    if (!blocks) shown.set(it.section, (blocks = new Map()));
    if (it.kind === "space") continue;
    let list = blocks.get(it.group);
    if (!list) blocks.set(it.group, (list = []));
    if (it.kind !== "label") list.push(it);
  }
  const chatOn = (space: string) => activeSpace === space && !settingsOpen && view === "chat";
  // The rows rendered now, as ghosts-to-be should they be deleted before the next render.
  const rowsNow = new Map<string, Ghost>();

  rowsNowRef.current = rowsNow;
  return (
    <ListContext value={ctx}>
      <TruncateTips suppressed={menuFor !== null || contextFor !== null} hideRef={hideTip} anchorOf={tipAnchor}>
      <SidebarContent
        scrollRef={scrollRef}
        fade="end"
        className="px-2 pb-3"
        onKeyDown={onKeyDown}
        onFocus={(e) => setFocused((e.target as HTMLElement).closest<HTMLElement>("[data-item-key]")?.dataset.itemKey ?? null)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null);
        }}
      >
        {filtering && !items.length ? <p className="flex h-7 items-center pl-8 text-subtle-foreground text-xs">No chats match “{query}”</p> : null}
        <ContextMenu open={contextFor !== null} onOpenChange={(o) => setContextFor(o ? contextTarget.current : null)}>
          <ContextMenuTrigger
            render={<div />}
            className="relative w-full"
            style={{ height: layout.size }}
            data-slot="sidebar-spaces"
            data-instant={instant || undefined}
            onContextMenuCapture={(e) => {
              const t = e.target as HTMLElement;
              // A title being edited gets the system's menu; a label or a gap gets none.
              if (t.closest("input")) {
                e.stopPropagation();
                return;
              }
              const key = t.closest<HTMLElement>("[data-item-key]")?.dataset.itemKey ?? null;
              const i = key ? layout.index.get(key) : undefined;
              contextTarget.current = i !== undefined && (items[i]!.kind === "row" || items[i]!.kind === "space") ? key : null;
            }}
          >
            {[...shown.keys()]
              .sort((a, b) => a - b)
              .map((si) => {
                const sec = sections[si]!;
                const input = inputs[si]!;
                const entry = spaceById.get(sec.space);
                if (!entry) return null;
                const blocks = shown.get(si)!;
                const bodyTop = sec.blocks[0]?.start ?? sec.end;
                const standIn = input.collapsed && chatOn(sec.space) && !!open[sec.space] && open[sec.space] !== DRAFT;
                return (
                  <div key={sec.space} data-slide="" className="absolute inset-x-0" style={{ top: sec.start, height: sec.end - sec.start }}>
                    <SpaceHeader space={entry.space} index={entry.index} folded={input.collapsed} count={input.count} standIn={standIn} filtering={filtering} />
                    {sec.blocks.length ? (
                      <ul
                        aria-label={`${entry.space.name} conversations`}
                        aria-busy={threads[sec.space]?.loadingMore || undefined}
                        className="absolute inset-x-0"
                        style={{ top: bodyTop - sec.start, height: sec.end - bodyTop }}
                      >
                        {[...blocks.keys()]
                          .sort((a, b) => a - b)
                          .map((bi) => {
                            const b = sec.blocks[bi]!;
                            const label = b.label !== undefined ? items[b.from]! : null;
                            return (
                              <li key={b.key} data-slide="" className="absolute inset-x-0" style={{ top: b.start - bodyTop, height: b.end - b.start, paddingTop: label ? label.size - LABEL : 0 }}>
                                {label ? (
                                  <div aria-hidden data-slot="sidebar-group-sticky" className="sticky top-7 z-10 flex h-7 items-center bg-sidebar pl-8 text-subtle-foreground text-xs">
                                    {b.label}
                                    {/* Stuck over rows, a short masked edge hides the cut-off text under it. */}
                                    <span data-slot="sidebar-group-sticky-edge" className="pointer-events-none absolute inset-x-0 top-full h-3 bg-sidebar mask-b-from-40%" />
                                  </div>
                                ) : null}
                                <ul aria-label={b.label} className="absolute inset-0">
                                    {blocks.get(bi)!.map((it) => {
                                      const y = it.start - b.start;
                                      if (it.kind === "row") {
                                        rowsNow.set(it.key, { item: it, block: `${sec.space}:${b.key}`, y });
                                        return (
                                          <RowSlot
                                            key={it.key}
                                            itemKey={it.key}
                                            y={y}
                                            fresh={isFresh(it)}
                                            space={it.space}
                                            thread={it.thread!}
                                            active={chatOn(it.space) && open[it.space] === it.thread!.id}
                                            renaming={renaming === it.key}
                                            menuOpen={menuFor === it.key}
                                          />
                                        );
                                      }
                                      if (it.kind === "loader") return <LoaderRow key={it.key} itemKey={it.key} space={it.space} mode={loaderMode(it.section)} y={y} />;
                                      return (
                                        <li key={it.key} className="absolute inset-x-0 top-0 flex h-7 items-center" style={{ transform: `translateY(${y}px)` }}>
                                          {it.kind === "skeleton" ? (
                                            <SidebarMenuSkeleton index={Number(it.key.slice(-1)) + 1} className="w-full pl-8" />
                                          ) : it.kind === "error" ? (
                                            <RowError className="h-7 pl-8" message="Couldn’t load conversations" onRetry={() => void loadThreads(it.space)} />
                                          ) : (
                                            <span className="pl-8 text-subtle-foreground text-xs">{it.text}</span>
                                          )}
                                        </li>
                                      );
                                    })}
                                    {Object.entries(ghosts).map(([k, g]) =>
                                      g.block === `${sec.space}:${b.key}` && !layout.index.has(k) ? (
                                        <RowSlot key={k} itemKey={k} y={g.y} fresh={false} leaving space={g.item.space} thread={g.item.thread!} active={false} renaming={false} menuOpen={false} />
                                      ) : null,
                                    )}
                                </ul>
                              </li>
                            );
                          })}
                      </ul>
                    ) : null}
                  </div>
                );
              })}
          </ContextMenuTrigger>
          <ContextMenuPopup>
            {/* The last target stays while the menu animates closed. */}
            {(contextFor ?? lastContext.current) ? <ItemMenu itemKey={(contextFor ?? lastContext.current)!} layout={layout} spaces={spaces} context /> : null}
          </ContextMenuPopup>
        </ContextMenu>
        <Menu handle={rowMenu}>
          {({ payload }) => (
            <MenuPopup align="start" side="right">
              {payload ? (
                <>
                  <OpenFor value={payload} onChange={setMenuFor} />
                  <ItemMenu itemKey={payload} layout={layout} spaces={spaces} context={false} />
                </>
              ) : null}
            </MenuPopup>
          )}
        </Menu>
      </SidebarContent>
      </TruncateTips>
    </ListContext>
  );
}
