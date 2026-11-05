/**
 * Which spaces have full access (src-tauri/src/full_access.rs): their CLI
 * runs with no walls, reading and changing anything on this computer and
 * using the internet. Kept by the core on this computer only and selected
 * explicitly in the space editor or composer access control.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";

import { inTauri } from "@/lib/tauri";

let on: ReadonlySet<string> = new Set();
let loaded = false;
const listeners = new Set<() => void>();

function set(next: ReadonlySet<string>) {
  on = next;
  listeners.forEach((l) => l());
}

function load() {
  if (loaded || !inTauri()) return;
  loaded = true;
  invoke<string[]>("full_access_list").then(
    (ids) => set(new Set(ids)),
    (e: unknown) => {
      loaded = false;
      console.warn("full_access_list:", e);
    },
  );
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** Whether `space` has full access. */
export function useFullAccess(space: string | undefined): boolean {
  useEffect(load, []);
  return useSyncExternalStore(subscribe, () => !!space && on.has(space));
}

/**
 * Persist the selected access mode and synchronize every control showing it.
 */
export async function setFullAccess(space: string, want: boolean): Promise<boolean> {
  const now = await invoke<boolean>("full_access_set", { id: space, on: want });
  const next = new Set(on);
  if (now) next.add(space);
  else next.delete(space);
  set(next);
  return now;
}
