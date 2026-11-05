import { useCallback, useSyncExternalStore } from "react";

// Host conversation state outlives the library's responsive/closed sheet subtree.
// This is session UI state; no thread contents or inferred activity are persisted.
const empty: ReadonlySet<string> = new Set();
const unread = new Map<string, ReadonlySet<string>>();
const listeners = new Map<string, Set<() => void>>();
const expanded = new Map<string, boolean>();

export function useConversationUnread(space: string) {
  const subscribe = useCallback((listener: () => void) => {
    let set = listeners.get(space);
    if (!set) { set = new Set(); listeners.set(space, set); }
    set.add(listener);
    return () => { set.delete(listener); if (!set.size) listeners.delete(space); };
  }, [space]);
  const snapshot = useCallback(() => unread.get(space) ?? empty, [space]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const update = useCallback((change: (previous: ReadonlySet<string>) => ReadonlySet<string>) => {
    const previous = unread.get(space) ?? empty;
    const next = change(previous);
    if (next.size === previous.size && [...next].every(id => previous.has(id))) return;
    if (next.size) unread.set(space, next); else unread.delete(space);
    listeners.get(space)?.forEach(listener => listener());
  }, [space]);
  return [value, update] as const;
}

export const rememberedSpaceExpansion = (space: string, fallback: boolean) => expanded.get(space) ?? fallback;
export const rememberSpaceExpansion = (space: string, value: boolean) => expanded.set(space, value);
