import { useSyncExternalStore } from "react";

/**
 * What each space is doing, so the shell can show it while you are elsewhere:
 * `running` while a reply streams, `needsYou` while a card waits for an answer.
 * The chat writes it; the sidebar and title bar read it.
 */
export type SpaceActivity = { running: boolean; needsYou: boolean };

const IDLE: SpaceActivity = { running: false, needsYou: false };
let state: Readonly<Record<string, SpaceActivity>> = {};
const listeners = new Set<() => void>();

export function setSpaceActivity(spaceId: string, activity: SpaceActivity): void {
  const prev = state[spaceId] ?? IDLE;
  if (prev.running === activity.running && prev.needsYou === activity.needsYou) return;
  state = { ...state, [spaceId]: activity };
  listeners.forEach((l) => l());
}

export function getSpaceActivity(spaceId: string): SpaceActivity {
  return state[spaceId] ?? IDLE;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Every space's activity; re-renders when any of it changes. */
export function useSpaceActivity(): Readonly<Record<string, SpaceActivity>> {
  return useSyncExternalStore(subscribe, () => state);
}
