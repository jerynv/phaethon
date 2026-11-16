import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SearchField, SearchFieldAction } from "@/components/ui/search-field";
import { Spinner } from "@/components/ui/spinner";
import { errorText } from "@/lib/core";
import { api } from "../api";
import { keysFor } from "../shortcuts";
import { THREAD_PAGE, useNav } from "../store";
import { nextResults, type FilterList } from "./paging";

export type { FilterList };

/**
 * The sidebar's search: the field beside New chat that narrows the listed
 * conversations by title. Loaded rows are filtered in the list at once; this
 * asks the core (`threads_list` with a query) for matches that aren't loaded,
 * page by page. ⌘K stays the full-text search.
 */


/**
 * The core's matches for `query` (folded) in each space, asked for once
 * typing pauses; older matches load as the list reaches them. What is
 * already loaded is filtered in the list itself, at once. A query that only
 * narrows the last one, in a space whose last answer was complete, is answered
 * here from that answer without asking again.
 */
export function useThreadFilter(query: string, spaceIds: readonly string[]) {
  const [results, setResults] = useState<Record<string, FilterList>>({});
  const gen = useRef(0);
  const latest = useRef(results);
  latest.current = results;
  const lastQuery = useRef("");
  const ids = spaceIds.join("\u0000");
  useEffect(() => {
    const g = ++gen.current;
    const prevQuery = lastQuery.current;
    lastQuery.current = query;
    if (!query) {
      setResults({});
      return;
    }
    const spaces = ids.split("\u0000").filter(Boolean);
    const next = nextResults(latest.current, spaces, prevQuery, query);
    setResults(next);
    const ask = spaces.filter((id) => next[id]!.loading);
    if (!ask.length) return;
    const t = setTimeout(() => {
      for (const id of ask) {
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

/**
 * The sidebar's one search field: typing narrows the space's conversations
 * by title at once; its keys (⌘K) open the full search, every space and every
 * message, starting from what was typed. Escape clears, ↓ moves into the
 * matches, Enter opens the first.
 */
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
  const setPalette = useNav((s) => s.setPalette);
  const { keys, aria } = keysFor("search");
  return (
    <SearchField
      className="flex-1"
      ref={inputRef}
      aria-label="Search chats"
      aria-keyshortcuts={aria}
      placeholder="Search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClear={() => onChange("")}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
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
      trailing={
        value ? (
          busy ? (
            <Spinner size="xs" className="mx-1 text-subtle-foreground" />
          ) : (
            <SearchFieldAction aria-label="Clear search" onClick={() => onChange("")}>
              <Icon icon={icons.close} />
            </SearchFieldAction>
          )
        ) : (
          <SearchFieldAction tabIndex={-1} aria-label="Search everything" onClick={() => setPalette(true)}>
            {keys.map((k) => (
              <span key={k}>{k}</span>
            ))}
          </SearchFieldAction>
        )
      }
    />
  );
}

export type ThreadFilter = ReturnType<typeof useThreadFilter>;
