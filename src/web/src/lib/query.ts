import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

/**
 * One cache for what screens read from the core, so the UI never shows a
 * loading state for something it already has:
 *
 * - A screen that comes back shows what it last read at once, and refreshes
 *   quietly when that is older than its `staleMs` (default 15 s).
 * - Two screens asking for the same thing share one request and one answer;
 *   when either sets or reloads it, both update.
 * - When the window comes back into focus, what's on screen refreshes quietly.
 * - `invalidate` marks entries stale after a change, refreshing the ones on
 *   screen; `setQueryData` puts a known answer in (an optimistic update, or
 *   what a write returned).
 *
 * Keys are explicit strings (`"memory:items"`, `["study:sources", space]`):
 * never derived from a function's source, which a minified build can make
 * identical for different reads. Errors are kept with the entry; a failed
 * refresh keeps the data it had.
 */

export type QueryKey = string | readonly unknown[];

type Entry = {
  data?: unknown;
  error?: unknown;
  /** When the data arrived (ms); 0 when there's none or it was invalidated. */
  at: number;
  inflight?: Promise<unknown>;
  /** Bumped on every change, for subscribers. */
  version: number;
  subs: Set<() => void>;
  /** The loader the most recent subscriber gave, for refreshes started from outside (focus, invalidate). */
  fn?: () => Promise<unknown>;
};

const MAX_ENTRIES = 400;
const cache = new Map<string, Entry>();

export function keyOf(key: QueryKey): string {
  return typeof key === "string" ? key : JSON.stringify(key);
}

function entry(k: string): Entry {
  let e = cache.get(k);
  if (!e) {
    e = { at: 0, version: 0, subs: new Set() };
    cache.set(k, e);
    if (cache.size > MAX_ENTRIES) {
      // Drop the oldest entries nobody is watching.
      for (const [key, old] of cache) {
        if (cache.size <= MAX_ENTRIES) break;
        if (!old.subs.size && !old.inflight && key !== k) cache.delete(key);
      }
    }
  } else {
    // Most recently used last.
    cache.delete(k);
    cache.set(k, e);
  }
  return e;
}

function changed(e: Entry): void {
  e.version++;
  for (const s of [...e.subs]) s();
}

/** Reads `key` with `fn`, sharing a request already in flight. Resolves with the data or rejects with the error. */
export function fetchQuery<T>(key: QueryKey, fn: () => Promise<T>): Promise<T> {
  const e = entry(keyOf(key));
  e.fn = fn as () => Promise<unknown>;
  if (e.inflight) return e.inflight as Promise<T>;
  const p = fn().then(
    (data) => {
      if (e.inflight === p) {
        e.inflight = undefined;
        e.data = data;
        e.error = undefined;
        e.at = Date.now();
        changed(e);
      }
      return data;
    },
    (error: unknown) => {
      if (e.inflight === p) {
        e.inflight = undefined;
        e.error = error;
        changed(e);
      }
      throw error;
    },
  );
  e.inflight = p;
  changed(e);
  return p;
}

/** What the cache holds for `key` now (undefined when nothing yet). */
export function getQueryData<T>(key: QueryKey): T | undefined {
  return cache.get(keyOf(key))?.data as T | undefined;
}

/** Puts an answer in the cache (or derives one from what's there); every screen showing it updates. */
export function setQueryData<T>(key: QueryKey, value: T | ((old: T | undefined) => T)): void {
  const e = entry(keyOf(key));
  e.data = typeof value === "function" ? (value as (old: T | undefined) => T)(e.data as T | undefined) : value;
  e.error = undefined;
  e.at = Date.now();
  changed(e);
}

/** Starts reading `key` before a screen needs it (hovering a link, opening a section). */
export function prefetch<T>(key: QueryKey, fn: () => Promise<T>, staleMs = 15_000): void {
  const e = cache.get(keyOf(key));
  if (e && (e.inflight || Date.now() - e.at < staleMs)) return;
  void fetchQuery(key, fn).catch(() => {});
}

/**
 * Marks entries stale: every key, keys starting with a prefix, or keys a test
 * picks. Entries on screen refresh at once (quietly, keeping their data);
 * the others refresh when next shown.
 */
export function invalidate(match?: string | ((key: string) => boolean)): void {
  const hit = (k: string) => (match === undefined ? true : typeof match === "string" ? k.startsWith(match) || k.startsWith(`["${match}`) : match(k));
  // A snapshot: refreshing an entry moves it to the end of the map (most recently used), which a live walk would visit again forever.
  for (const [k, e] of [...cache]) {
    if (!hit(k)) continue;
    e.at = 0;
    if (e.subs.size && e.fn) void fetchQuery(k, e.fn).catch(() => {});
  }
}

/** Tests: watch a key the way a mounted screen does. */
export function subscribeForTest(key: QueryKey, fn: () => Promise<unknown>): () => void {
  const e = entry(keyOf(key));
  const cb = () => {};
  e.subs.add(cb);
  e.fn = fn;
  return () => e.subs.delete(cb);
}

/** Tests. */
export function clearQueries(): void {
  cache.clear();
}

if (typeof window !== "undefined") {
  // Coming back to the window: what's on screen refreshes, if it's been a while.
  let last = Date.now();
  const refresh = () => {
    if (Date.now() - last < 5_000) return;
    last = Date.now();
    for (const [k, e] of [...cache]) if (e.subs.size && e.fn && Date.now() - e.at > 5_000) void fetchQuery(k, e.fn).catch(() => {});
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refresh());
}

export type Query<T> = {
  data: T | undefined;
  error: unknown;
  /** True only while there is nothing to show yet (a first load). */
  loading: boolean;
  /** True while any read is running, including a quiet refresh. */
  fetching: boolean;
  reload: () => Promise<void>;
  setData: (value: T | ((old: T | undefined) => T)) => void;
};

/**
 * Reads `key` for a screen. `null` reads nothing (and returns nothing). Shows
 * the cached answer at once; reads again when it is older than `staleMs`.
 */
export function useQuery<T>(key: QueryKey | null, fn: () => Promise<T>, opts: { staleMs?: number } = {}): Query<T> {
  const k = key === null ? null : keyOf(key);
  const staleMs = opts.staleMs ?? 15_000;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const subscribe = useCallback(
    (cb: () => void) => {
      if (k === null) return () => {};
      const e = entry(k);
      e.subs.add(cb);
      return () => e.subs.delete(cb);
    },
    [k],
  );
  const version = useSyncExternalStore(
    subscribe,
    () => (k === null ? -1 : (cache.get(k)?.version ?? 0)),
    () => -1,
  );
  void version;
  const e = k === null ? undefined : cache.get(k);
  useEffect(() => {
    if (k === null) return;
    const cur = entry(k);
    cur.fn = () => fnRef.current();
    if (cur.inflight) return;
    if (cur.at && Date.now() - cur.at < staleMs && cur.data !== undefined) return;
    void fetchQuery(k, () => fnRef.current()).catch(() => {});
  }, [k, staleMs]);
  const reload = useCallback(async () => {
    if (k === null) return;
    await fetchQuery(k, () => fnRef.current()).catch(() => {});
  }, [k]);
  const setData = useCallback((value: T | ((old: T | undefined) => T)) => k !== null && setQueryData(k, value), [k]);
  const data = e?.data as T | undefined;
  // A failed quiet refresh keeps the data on screen; the error shows only when there's nothing else.
  return { data, error: data === undefined ? e?.error : undefined, loading: k !== null && data === undefined && !e?.error, fetching: !!e?.inflight, reload, setData };
}
