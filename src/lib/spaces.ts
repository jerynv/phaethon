import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";

import { inTauri } from "./tauri";

/**
 * One space in the vault. Mirrors `SpaceView` in src-tauri/src/spaces.rs: the
 * id is the folder name under `<vault>/spaces/` and never changes; name,
 * description and hue come from `<space>/.phaethon/space.json`.
 */
export type Space = {
  id: string;
  name: string;
  description: string;
  /**
   * The space's own hue (oklch hue angle, 0 to 360). It becomes `--ph-space-h`
   * wherever the space is shown, so each compartment is recognisable at a
   * glance. Lightness and chroma come from the theme tokens, so any hue stays
   * soft and keeps its contrast.
   */
  hue: number;
  /**
   * When the space was last used (opened, a message sent, a reply finished),
   * in milliseconds since 1970; null or missing when never. Kept by the core in
   * the space's own folder, so it syncs with the vault.
   */
  lastUsed?: number | null;
};

/** What a new space starts with. Description and hue are optional. */
export type NewSpace = { name: string; description?: string; hue?: number };
/** Fields to change; the ones left out stay as they are. */
export type SpacePatch = { name?: string; description?: string; hue?: number };

/** Longest name and description the core accepts (src-tauri/src/spaces.rs). */
export const SPACE_NAME_MAX = 60;
export const SPACE_DESCRIPTION_MAX = 160;

/** Outside the desktop app (`pnpm dev`) there is no vault: these stand in, and changes stay in memory. */
const FIXTURE: readonly Space[] = [
  { id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 240 },
  { id: "work", name: "Work", description: "Projects, meetings, follow-ups", hue: 50 },
];

export type SpacesState = {
  status: "loading" | "ready" | "error";
  spaces: readonly Space[];
  /** Why the list could not be loaded (status "error" only). */
  error: string | null;
};

// ---- Store ----
// One list for the whole app: the sidebar, title bar, chat and Settings all
// read it, and it reloads after a change here and whenever the window regains
// focus (a folder may have been added or space.json edited by hand).

// The list as the core gave it (most recently used first), and the list as
// shown. They differ only while the order is held (see holdSpaceOrder).
let data: SpacesState = inTauri()
  ? { status: "loading", spaces: [], error: null }
  : { status: "ready", spaces: FIXTURE, error: null };
let state: SpacesState = data;
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function set(next: SpacesState) {
  data = { ...next, spaces: byUse(next.spaces) };
  show();
}

function show() {
  const spaces = holds.size ? inShownOrder(data.spaces) : data.spaces;
  state = { ...data, spaces };
  listeners.forEach((l) => l());
}

// ---- Order ----
// Most recently used first: opening a space, sending a message in it or a
// reply finishing there moves it to the top. Cmd+1…9 follow the order shown.
// The core keeps when each space was last used and lists them in that order
// (spaces never used after, by name); a use seen here moves the space at once,
// without waiting for the core. So that the list never jumps under the
// pointer or the keyboard focus, the sidebar holds the order while it is
// pointed at, focused or showing a space's menu; the new order shows once all
// of those end.

// The manual order this computer once kept; no longer used.
try {
  localStorage.removeItem("phaethon.space-order");
} catch {
  // No storage: nothing to clear.
}

/** Most recent first; spaces never used keep the order they came in (the core's: by name). */
const byUse = (list: readonly Space[]): readonly Space[] => [...list].sort((a, b) => (b.lastUsed ?? -1) - (a.lastUsed ?? -1));

const holds = new Set<string>();

/** `list` in the order shown now, with spaces not shown yet after them. */
function inShownOrder(list: readonly Space[]): readonly Space[] {
  const at = new Map(state.spaces.map((s, i) => [s.id, i]));
  const kept = list.filter((s) => at.has(s.id)).sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0));
  return [...kept, ...list.filter((s) => !at.has(s.id))];
}

/**
 * Hold the order shown (`on`) for `reason` ("pointer", "focus", "menu"), or
 * stop holding it for that reason. Names, colours and new spaces still update
 * while it is held; the order catches up once nothing holds it.
 */
export function holdSpaceOrder(reason: string, on: boolean): void {
  const had = holds.size > 0;
  if (on) holds.add(reason);
  else holds.delete(reason);
  if (had && holds.size === 0) show();
}

/**
 * Note that the space `id` was just used. `save` also tells the core (when it
 * is opened; sending and replies the core notes itself).
 */
export function markSpaceUsed(id: string, save: boolean): void {
  if (!data.spaces.some((s) => s.id === id)) return;
  const now = Date.now();
  set({ ...data, spaces: data.spaces.map((s) => (s.id === id ? { ...s, lastUsed: now } : s)) });
  if (save && inTauri()) invoke("space_touch", { id }).catch((e: unknown) => console.warn("space_touch:", e));
}

/** Load the list again from the vault. A failed reload keeps the last list shown. */
export function refreshSpaces(): Promise<void> {
  if (!inTauri()) return Promise.resolve();
  inFlight ??= invoke<Space[]>("spaces_list")
    .then(
      (spaces) => set({ status: "ready", spaces, error: null }),
      (e: unknown) => {
        if (data.status !== "ready") set({ status: "error", spaces: [], error: String(e) });
      },
    )
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** The list as it is now, for code outside React (labels, tool activity). */
export const getSpaces = (): readonly Space[] => state.spaces;

/** A space by id, or undefined when this vault has no such space. */
export const findSpace = (id: string): Space | undefined => state.spaces.find((s) => s.id === id);

/** Create a space; resolves with it (its id is derived from the name by the core). Rejects with a plain message. */
export async function createSpace(input: NewSpace): Promise<Space> {
  let made: Space;
  if (inTauri()) {
    made = await invoke<Space>("space_create", { name: input.name, description: input.description ?? null, hue: input.hue ?? null });
  } else {
    const name = input.name.trim();
    if (!name) throw "A space needs a name.";
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "space";
    let id = base;
    for (let n = 2; data.spaces.some((s) => s.id === id); n++) id = `${base}-${n}`;
    made = { id, name, description: input.description?.trim() ?? "", hue: input.hue ?? 168 };
    set({ ...data, spaces: [...data.spaces, made] });
  }
  await refreshSpaces();
  return made;
}

/** Change a space's name, description or hue. Resolves with the space as saved. Rejects with a plain message. */
export async function updateSpace(id: string, patch: SpacePatch): Promise<Space> {
  let saved: Space;
  if (inTauri()) {
    saved = await invoke<Space>("space_update", { id, name: patch.name ?? null, description: patch.description ?? null, hue: patch.hue ?? null });
  } else {
    const old = findSpace(id);
    if (!old) throw `There is no space “${id}” in this vault.`;
    if (patch.name !== undefined && !patch.name.trim()) throw "A space needs a name.";
    saved = { ...old, ...patch, name: patch.name?.trim() ?? old.name, description: patch.description?.trim() ?? old.description };
    set({ ...data, spaces: data.spaces.map((s) => (s.id === id ? saved : s)) });
  }
  await refreshSpaces();
  return saved;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const snapshot = () => state;

let watching = false;
/** Reload on window focus, once for the app. */
function watchFocus() {
  if (watching || !inTauri()) return;
  watching = true;
  window.addEventListener("focus", () => void refreshSpaces());
}

/**
 * The vault's spaces, kept fresh. The first use loads them; later uses share
 * the same list. Components that show a space's name or colour by id (labels
 * built with findSpace) call this too, so they redraw after a rename.
 */
export function useSpaces(): SpacesState {
  const s = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    watchFocus();
    if (data.status === "loading") void refreshSpaces();
  }, []);
  return s;
}

// ---- The space being shown ----
// Every visited space's conversation stays mounted (hidden when it is not the
// one shown), so a reply keeps running and a card keeps waiting while you look
// elsewhere. Code that acts on "the" conversation (a shortcut such as Cmd+N,
// focusing the composer) checks this first, so only the shown space reacts.

let activeId: string | null = null;
const activeListeners = new Set<() => void>();

/** Set by the shell whenever the shown space changes. Showing a space counts as using it. */
export function setActiveSpaceId(id: string | null): void {
  if (id === activeId) return;
  activeId = id;
  if (id) markSpaceUsed(id, true);
  activeListeners.forEach((l) => l());
}

/** The id of the space being shown, or null when there is none. */
export const getActiveSpaceId = (): string | null => activeId;

/** The id of the space being shown; re-renders when it changes. */
export function useActiveSpaceId(): string | null {
  return useSyncExternalStore(
    (cb) => {
      activeListeners.add(cb);
      return () => activeListeners.delete(cb);
    },
    () => activeId,
  );
}
