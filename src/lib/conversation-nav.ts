import { useSyncExternalStore } from "react";

import type { ThreadSummary } from "@/lib/backend";

/**
 * Each space's conversations as its conversations bar knows them, so the
 * sidebar and the title bar can show them without a second copy of the
 * bar's logic. The bar (src/components/chat/conversations-bar.tsx) owns the
 * list, the running guard and the switch; it publishes them here, and the
 * sidebar's rows call back into it (`open`, `startNew`), so a switch from
 * the sidebar is refused or announced exactly as one from the bar's menu.
 */
export type ConversationNav = {
  /** Newest first, as threads_list gives them; the open one has `current`. */
  threads: readonly ThreadSummary[];
  status: "loading" | "ready" | "error";
  working: boolean;
  /** A reply is running in the space: a switch is refused. */
  running: boolean;
  /** Open a saved conversation (the bar's own choose). */
  open: (t: ThreadSummary) => void;
  /** Start a new conversation (the bar's own New conversation). */
  startNew: () => void;
  /** Open the bar's full Conversations menu (history, Delete, Clear, Find earlier). */
  showAll: () => void;
};

let state: Readonly<Record<string, ConversationNav>> = {};
const listeners = new Set<() => void>();

export function publishConversations(spaceId: string, nav: ConversationNav | null): void {
  if (nav) state = { ...state, [spaceId]: nav };
  else {
    if (!(spaceId in state)) return;
    const { [spaceId]: _gone, ...rest } = state;
    state = rest;
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The space's conversations, or undefined until its pane has mounted. */
export function useConversations(spaceId: string | undefined): ConversationNav | undefined {
  return useSyncExternalStore(subscribe, () => (spaceId ? state[spaceId] : undefined));
}

/** The space's conversations right now, for one-off actions (the palette's New conversation). */
export function getConversations(spaceId: string): ConversationNav | undefined {
  return state[spaceId];
}

/**
 * Where a space's conversations bar draws its controls (Conversations and New
 * conversation): the docked sidebar, under the current space, gives a place
 * here; while it gives none (sidebar hidden or over the conversation), the
 * space's pane shows them in its compact header. The bar stays mounted in its
 * pane either way, so its state and its Cmd+N survive the move.
 */
let hosts: Readonly<Record<string, HTMLElement>> = {};
const hostListeners = new Set<() => void>();

export function setConversationHost(spaceId: string, el: HTMLElement | null): void {
  if ((hosts[spaceId] ?? null) === el) return;
  if (el) hosts = { ...hosts, [spaceId]: el };
  else {
    const { [spaceId]: _gone, ...rest } = hosts;
    hosts = rest;
  }
  hostListeners.forEach((l) => l());
}

const subscribeHosts = (l: () => void) => {
  hostListeners.add(l);
  return () => hostListeners.delete(l);
};

export function useConversationHost(spaceId: string): HTMLElement | null {
  return useSyncExternalStore(subscribeHosts, () => hosts[spaceId] ?? null);
}
