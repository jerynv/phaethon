import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { RowError } from "@/components/errors";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Menu, MenuItem, MenuPopup, MenuSeparator } from "@/components/ui/menu";
import { SidebarContent, SidebarMenuSkeleton } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import type { SpaceView } from "../api";
import { DRAFT, useNav, type ThreadList, type ThreadRow } from "../store";
import type { ThreadFilter } from "./filter";
import { foldTitle, LABEL, layoutSpaces, revealOffset, ROW, threadKey, type Item, type Layout, type SpaceInput } from "./layout";
import { ListContext, type ListContextValue } from "./list-context";
import { LoaderRow, RowSlot, ThreadMenuItems } from "./rows";
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
 * next page when it comes near the view. Keyboard: arrows, Home and End move
 * through space rows and conversations, scrolling as they go; the focused
 * row, one being renamed and one with its menu open stay rendered while they
 * scroll away. The open conversation scrolls into view when it changes (from
 * search, or on start), once it is listed.
 */

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

export type SpacesListHandle = { focusFirst(rowsOnly?: boolean): void; openFirst(): void };

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
      const found = filter.results[sp.id];
      const byId = new Map(data.map((t) => [t.id, t]));
      const match = (t: ThreadRow) => foldTitle(t.title).includes(query);
      const rows = unique([...data.filter(match), ...(found?.items ?? NO_ROWS).map((t) => byId.get(t.id) ?? t).filter(match)]);
      const loading = !found || found.loading;
      const hasMore = !!found && !found.loading && found.hasMore;
      // A space with nothing matching drops out of the list.
      if (!rows.length && !loading && !hasMore) continue;
      out.push({
        id: sp.id,
        collapsed: false,
        status: rows.length ? "ready" : loading ? "loading" : found?.error ? "error" : "ready",
        rows,
        hasMore,
        cursor: found?.cursor ?? null,
        empty: "No matches",
        count: Math.max(rows.length, found?.total ?? 0),
      });
    }
    return out;
  }, [spaces, threads, collapsed, filtering, query, filter.results]);
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

  // ---- Nothing slides or fades while the filter swaps the list.
  const [instant, setInstant] = useState(false);
  const [shownQuery, setShownQuery] = useState(query);
  if (shownQuery !== query) {
    setShownQuery(query);
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

  // ---- Paging: the loader row near the view asks for the next page.
  const [moreFailed, setMoreFailed] = useState<Record<string, true>>({});
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  /** Where the list was scrolled when a space's last page settled: a loader still in view there waits for the next scroll, so pages never load back to back on their own. */
  const settledAt = useRef<Record<string, number>>({});
  const inFlight = useRef(new Set<string>());
  const requestMore = useCallback(
    (space: string, loaderIndex: number) => {
      const el = scrollRef.current;
      if (moreFailed[space] || !el || inFlight.current.has(space) || settledAt.current[space] === el.scrollTop) return;
      inFlight.current.add(space);
      // Rows of this space read on their own from further back (one opened from search) sit below the loader; the page goes in above them, so the first one in view stays put.
      const first = items.findIndex((it, i) => i > loaderIndex && it.kind === "row" && it.space === space && it.start >= el.scrollTop);
      anchor.current = first !== -1 && items[first]!.start < el.scrollTop + el.clientHeight ? { key: items[first]!.key, offset: items[first]!.start - el.scrollTop } : null;
      const run = filtering ? filter.loadMore(space) : loadMoreThreads(space);
      run.then(
        () =>
          requestAnimationFrame(() => {
            settledAt.current[space] = el.scrollTop;
            anchor.current = null;
            inFlight.current.delete(space);
          }),
        () => {
          anchor.current = null;
          inFlight.current.delete(space);
          setMoreFailed((f) => ({ ...f, [space]: true }));
        },
      );
    },
    [moreFailed, items, filtering, filter, loadMoreThreads],
  );
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    for (const v of rendered) {
      const it = items[v.index];
      // In view or within a screen below it; one above the view (just pushed up by a page loading below it) waits until it is scrolled back to.
      if (it?.kind === "loader" && it.start + it.size > el.scrollTop && it.start < el.scrollTop + 2 * el.clientHeight) requestMore(it.space, v.index);
    }
  }, [rendered, items, requestMore]);
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = scrollRef.current;
    if (!a || !el) return;
    const i = layout.index.get(a.key);
    if (i === undefined) return;
    const delta = items[i]!.start - el.scrollTop - a.offset;
    if (!delta) return;
    el.scrollTop += delta;
    anchor.current = null;
  }, [layout, items]);
  // A reload starts the space's pages over; a failed page gets another go.
  useEffect(() => {
    setMoreFailed((f) => (Object.keys(f).some((s) => threads[s]?.loading) ? Object.fromEntries(Object.entries(f).filter(([s]) => !threads[s]?.loading)) : f));
  }, [threads]);

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
  useLayoutEffect(() => {
    if (!focusTo) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-item-key="${CSS.escape(focusTo)}"] [data-nav-row]`);
    if (el) el.focus({ preventScroll: true });
    setFocusTo(null);
  }, [focusTo]);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const key = (e.target as HTMLElement).closest<HTMLElement>("[data-item-key]")?.dataset.itemKey;
    const at = key ? layout.index.get(key) : undefined;
    if (at === undefined) return;
    e.preventDefault();
    const focusable = (it: Item | undefined) => it?.kind === "space" || it?.kind === "row";
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
  }));

  // ---- Shared with rows, stable for the list's life.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const instantRef = useRef(instant);
  instantRef.current = instant;
  const onDeleteRef = useRef(onDelete);
  onDeleteRef.current = onDelete;
  const ctx = useMemo<ListContextValue>(
    () => ({
      onDelete: (space, t) => onDeleteRef.current(space, t),
      rename: setRenaming,
      listed: (key) => layoutRef.current.index.has(key),
      instant: () => instantRef.current,
      retryMore: (space) => setMoreFailed(({ [space]: _, ...rest }) => rest),
      rowMenu,
    }),
    [rowMenu],
  );

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

  return (
    <ListContext value={ctx}>
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
            className={cn("relative w-full", !instant && "[&_[data-slide]]:transition-[transform,top] [&_[data-slide]]:duration-200 [&_[data-slide]]:ease-out-soft")}
            style={{ height: layout.size }}
            data-slot="sidebar-spaces"
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
                                  <div aria-hidden className="sticky top-7 z-10 flex h-7 items-center bg-sidebar pl-8 text-subtle-foreground text-xs">
                                    {b.label}
                                  </div>
                                ) : null}
                                <ul aria-label={b.label} className="absolute inset-0">
                                  <AnimatePresence initial={false}>
                                    {blocks.get(bi)!.map((it) => {
                                      const y = it.start - b.start;
                                      if (it.kind === "row")
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
                                      if (it.kind === "loader") return <LoaderRow key={it.key} space={it.space} failed={!!moreFailed[it.space]} y={y} />;
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
                                  </AnimatePresence>
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
    </ListContext>
  );
}
