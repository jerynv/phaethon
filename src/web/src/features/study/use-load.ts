import { useId } from "react";
import { useQuery, type QueryKey } from "@/lib/query";

export type Loaded<T> = { data?: T; error?: unknown; loading: boolean; fetching: boolean; reload: () => void; setData: (f: (d: T | undefined) => T | undefined) => void };

/**
 * One core read for a screen, through the shared cache (lib/query.ts): data,
 * the error when there's nothing to show, `loading` only on a first load
 * (a revisit shows its last answer at once and refreshes quietly) and
 * `fetching` while any read runs. With a `key`, screens reading the same
 * thing share it; without one, the cache is this component's own.
 */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[], key?: QueryKey): Loaded<T> {
  const own = useId();
  const k: unknown[] = key === undefined ? ["own", own] : typeof key === "string" ? [key] : [...key];
  const q = useQuery<T>([...k, ...deps], load);
  return {
    data: q.data,
    error: q.error,
    loading: q.loading,
    fetching: q.fetching,
    reload: () => void q.reload(),
    setData: (f) => q.setData((d) => f(d) as T),
  };
}
