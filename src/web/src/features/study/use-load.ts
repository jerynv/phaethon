import { useCallback, useEffect, useRef, useState } from "react";

export type Loaded<T> = { data?: T; error?: unknown; loading: boolean; reload: () => void; setData: (f: (d: T | undefined) => T | undefined) => void };

/**
 * One core read for a screen: data, the error of the last try, and whether a
 * load is running. A newer load wins over an older one still in flight; a
 * failed reload keeps the data it had.
 */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    load().then(
      (data) => n === seq.current && setState({ data, loading: false }),
      (error: unknown) => n === seq.current && setState((s) => ({ data: s.data, error, loading: false })),
    );
  }, deps);
  useEffect(() => reload(), [reload]);
  const setData = useCallback((f: (d: T | undefined) => T | undefined) => setState((s) => ({ ...s, data: f(s.data) })), []);
  return { ...state, reload, setData };
}
