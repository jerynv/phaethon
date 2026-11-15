import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SidebarMenuAction } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { errorText } from "@/lib/core";
import { api } from "../api";
import { THREAD_PAGE, type ThreadRow } from "../store";

/**
 * The sidebar's filter: the row under New chat that narrows the listed
 * conversations by title. Loaded rows are filtered in the list at once; this
 * asks the core (`threads_list` with a query) for matches that aren't loaded,
 * page by page. ⌘K stays the full-text search.
 */

/** One space's matches from the core for the filter, page by page. */
export type FilterList = { items: ThreadRow[]; total?: number; hasMore: boolean; cursor: string | null; loading: boolean; loadingMore: boolean; error?: string };

/**
 * The core's matches for `query` (folded) in each space, asked for once
 * typing pauses; older matches load as the list reaches them. What is
 * already loaded is filtered in the list itself, at once.
 */
export function useThreadFilter(query: string, spaceIds: readonly string[]) {
  const [results, setResults] = useState<Record<string, FilterList>>({});
  const gen = useRef(0);
  const ids = spaceIds.join("\u0000");
  useEffect(() => {
    const g = ++gen.current;
    if (!query) {
      setResults({});
      return;
    }
    const spaces = ids.split("\u0000").filter(Boolean);
    // The last answer stays (the list re-filters it at once) until this one arrives.
    setResults((r) => Object.fromEntries(spaces.map((id) => [id, { ...(r[id] ?? { items: [], hasMore: false, cursor: null, loadingMore: false }), loading: true }])));
    const t = setTimeout(() => {
      for (const id of spaces) {
        api.threads(id, { query, limit: THREAD_PAGE }).then(
          (page) => {
            if (g !== gen.current) return;
            setResults((r) => ({ ...r, [id]: { items: page.items, total: page.total, hasMore: page.hasMore, cursor: page.nextCursor, loading: false, loadingMore: false } }));
          },
          (e) => {
            if (g !== gen.current) return;
            setResults((r) => ({ ...r, [id]: { items: [], hasMore: false, cursor: null, loading: false, loadingMore: false, error: errorText(e) } }));
          },
        );
      }
    }, 150);
    return () => clearTimeout(t);
  }, [query, ids]);

  const latest = useRef(results);
  latest.current = results;
  const loadMore = useCallback(
    async (space: string) => {
      const cur = latest.current[space];
      if (!query || !cur || cur.loading || cur.loadingMore || !cur.hasMore || !cur.cursor) return;
      const g = gen.current;
      setResults((r) => ({ ...r, [space]: { ...r[space]!, loadingMore: true } }));
      try {
        const page = await api.threads(space, { query, limit: THREAD_PAGE, before: cur.cursor });
        if (g !== gen.current) return;
        setResults((r) => {
          const had = new Set(r[space]!.items.map((t) => t.id));
          return { ...r, [space]: { ...r[space]!, items: [...r[space]!.items, ...page.items.filter((t) => !had.has(t.id))], hasMore: page.hasMore, cursor: page.nextCursor, loadingMore: false } };
        });
      } catch (e) {
        if (g === gen.current) setResults((r) => ({ ...r, [space]: { ...r[space]!, loadingMore: false } }));
        throw e;
      }
    },
    [query],
  );
  const drop = useCallback((space: string, id: string) => {
    setResults((r) => (r[space] ? { ...r, [space]: { ...r[space]!, items: r[space]!.items.filter((t) => t.id !== id), total: r[space]!.total ? r[space]!.total! - 1 : r[space]!.total } } : r));
  }, []);
  const busy = Object.values(results).some((r) => r.loading);
  return { results, loadMore, drop, busy };
}

/** The filter row: a magnifier in the icon column and "Filter chats"; Escape clears it, ↓ moves into the matches. */
export function FilterField({
  value,
  onChange,
  busy,
  inputRef,
  onDown,
  onUp,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  inputRef: Ref<HTMLInputElement>;
  onDown: () => void;
  onUp: () => void;
  onEnter: () => void;
}) {
  return (
    <div className="group/filter relative flex h-7 items-center rounded-md transition-colors hover:bg-accent has-focus-visible:bg-transparent">
      <Icon icon={icons.search} className="pointer-events-none absolute left-2 size-4 text-icon-muted" />
      <input
        ref={inputRef}
        type="text"
        role="searchbox"
        aria-label="Filter chats"
        placeholder="Filter chats"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (!value) return;
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            onDown();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            onUp();
          } else if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
        className="h-7 w-full min-w-0 rounded-md bg-transparent pr-7 pl-8 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
      />
      {value ? (
        <span className="absolute right-1 flex items-center">
          {busy ? (
            <Spinner size="xs" className="mr-1 text-subtle-foreground" />
          ) : (
            <SidebarMenuAction aria-label="Clear filter" onClick={() => onChange("")}>
              <Icon icon={icons.close} />
            </SidebarMenuAction>
          )}
        </span>
      ) : null}
    </div>
  );
}

export type ThreadFilter = ReturnType<typeof useThreadFilter>;
