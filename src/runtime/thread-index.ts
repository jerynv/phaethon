import { useSyncExternalStore } from "react";

/**
 * Which shown message sits where in the space's saved thread (thread.json),
 * so Edit and Regenerate can ask the backend to replace from that point
 * (agent_send `replaceFrom`). Only messages whose saved position is known can
 * be edited or regenerated truthfully; the others show no such action.
 *
 * Known from the saved thread when it loads, and refreshed after every reply
 * by matching the saved thread against the shown one from the start.
 */
export class ThreadIndex {
  private byId = new Map<string, number>();
  /** The thread as last shown after a reply (or as loaded): ids and roles in order. */
  private shown: { id: string; role: string }[] = [];
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(initial: readonly { id: string; role: string; index?: number }[] = []) {
    this.shown = initial.map(({ id, role }) => ({ id, role }));
    for (const m of initial) if (m.index !== undefined) this.byId.set(m.id, m.index);
  }

  /** The saved position of a shown message, if known. */
  indexOf(id: string): number | undefined {
    return this.byId.get(id);
  }

  /**
   * Where a run starting from `prefix` (the shown messages before the newest
   * user message) forks the thread: undefined for a plain new message, else
   * the saved position of the message being replaced (edit or regenerate),
   * or null when that position is not known.
   */
  forkPoint(prefixIds: readonly string[]): number | null | undefined {
    const same = prefixIds.length === this.shown.length && prefixIds.every((id, i) => this.shown[i]?.id === id);
    if (same) return undefined;
    const replaced = this.shown[prefixIds.length];
    if (!replaced) return undefined;
    return this.byId.get(replaced.id) ?? null;
  }

  /** After a reply: the thread now shown, and the saved one to match it against. */
  settle(shown: { id: string; role: string }[], saved: readonly { role: string; index: number }[] | null) {
    this.shown = shown;
    if (saved) {
      const next = new Map<string, number>();
      for (let i = 0; i < shown.length; i++) {
        const s = saved[i];
        if (!s || s.role !== shown[i].role) break;
        next.set(shown[i].id, s.index);
      }
      this.byId = next;
    } else {
      // Without the saved thread, keep what is still shown.
      const ids = new Set(shown.map((m) => m.id));
      for (const id of [...this.byId.keys()]) if (!ids.has(id)) this.byId.delete(id);
    }
    this.version++;
    this.listeners.forEach((l) => l());
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getVersion = () => this.version;
}

/** True when the message's saved position is known (so Edit / Regenerate can be offered). */
export function useKnownIndex(index: ThreadIndex | null, id: string | undefined): boolean {
  useSyncExternalStore(index ? index.subscribe : noop, index ? index.getVersion : zero);
  return !!index && id !== undefined && index.indexOf(id) !== undefined;
}

const noop = () => () => {};
const zero = () => 0;
