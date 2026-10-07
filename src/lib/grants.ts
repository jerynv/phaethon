import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { findSpace } from "./spaces";
import { inTauri } from "./tauri";

/** Mirrors `GrantView` in src-tauri/src/grants.rs. `path` is relative to `from`, `/`-separated. */
export interface GrantView {
  id: string;
  /** The space that is read. */
  from: string;
  path: string;
  /** ISO 8601, UTC. */
  created: string;
  scope: "always" | "once";
}

/** Mirrors `GrantsView`: what one space may read, plus notes on ignored entries in grants.json. */
export interface GrantsView {
  grants: GrantView[];
  problems: string[];
}

/** Grants where `to == space`. Rejects with a message for an invalid space. */
export const listGrants = (space: string) => invoke<GrantsView>("grants_list", { space });

/**
 * Remove a saved grant. Resolves false when no grant has that id (already
 * gone). Rejects when grants.json cannot be edited. Tells every listener.
 */
export async function revokeGrant(id: string): Promise<boolean> {
  try {
    return await invoke<boolean>("grant_revoke", { id });
  } finally {
    notifyGrantsChanged();
  }
}

// ---- Change signal ----
// Grants change outside the views that show them (an "Always allow" answer in
// the conversation, a revoke in Settings), so every view listens here.

const changes = new EventTarget();

/** Call after anything that may have added or removed a grant. */
export function notifyGrantsChanged() {
  changes.dispatchEvent(new Event("change"));
}

/** Subscribe to grant changes. Returns the unsubscribe function. */
export function onGrantsChanged(cb: () => void): () => void {
  changes.addEventListener("change", cb);
  return () => changes.removeEventListener("change", cb);
}

// ---- Presentation helpers ----

/**
 * A space's display name and hue. An id that is not a space in this vault
 * reads "Home (not in this vault)", title-cased, and has no hue (its mark is a
 * dashed neutral ring).
 */
export function spaceInfo(id: string): { name: string; hue: number | undefined; known: boolean } {
  const s = findSpace(id);
  if (s) return { name: s.name, hue: s.hue, known: true };
  const titled = id ? id.charAt(0).toUpperCase() + id.slice(1) : "Unknown space";
  return { name: `${titled} (not in this vault)`, hue: undefined, known: false };
}

/** "Work / calendar", or "All of Work" for a grant on a whole space; as spoken and shown. */
export function grantLabel(g: GrantView): string {
  const space = spaceInfo(g.from).name;
  return g.path ? `${space} / ${g.path}` : `All of ${space}`;
}

/**
 * A long path shortened in the middle, keeping its first folder and its last
 * part (the file or folder that tells it apart): "archive/…/amendment-3.pdf".
 */
export function shortPath(path: string, max = 32): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  if (parts.length <= 2) return path;
  return `${parts[0]}/…/${parts[parts.length - 1]}`;
}

/** "folder", "file" or "place" for a set of grants (a last segment with a dot is a file). */
export function grantNoun(grants: readonly GrantView[], plural: boolean): string {
  const isFile = (g: GrantView) => /\.[^/]+$/.test(g.path.split("/").pop() ?? "");
  const files = grants.filter(isFile).length;
  const noun = files === grants.length ? "file" : files === 0 ? "folder" : "place";
  return plural ? `${noun}s` : noun;
}

/** "Oct 9, 2026", or null when the date cannot be read. */
export function grantDate(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(d);
}

// ---- Hook ----

export type GrantsState =
  | { status: "loading" }
  | { status: "ready"; grants: GrantView[]; problems: string[] }
  | { status: "error"; error: string };

const EMPTY: GrantsState = { status: "ready", grants: [], problems: [] };

/**
 * What `space` may read in other spaces, kept fresh: reloads when the space
 * changes, when grants change anywhere in the app, and when the window regains
 * focus (grants.json may have been edited by hand). Outside Tauri there are no
 * grants. A reload keeps showing the last answer instead of flashing "loading".
 */
export function useGrants(space: string) {
  const [state, setState] = useState<GrantsState>(() => (inTauri() && space ? { status: "loading" } : EMPTY));
  const seq = useRef(0);
  const shownFor = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    // No space (a vault with none yet): nothing can be granted.
    if (!inTauri() || !space) return;
    const mine = ++seq.current;
    if (shownFor.current !== space) setState({ status: "loading" });
    try {
      const v = await listGrants(space);
      if (mine !== seq.current) return;
      shownFor.current = space;
      setState({ status: "ready", grants: v.grants ?? [], problems: v.problems ?? [] });
    } catch (e) {
      if (mine !== seq.current) return;
      shownFor.current = space;
      setState({ status: "error", error: String(e) });
    }
  }, [space]);

  useEffect(() => {
    void refresh();
    const off = onGrantsChanged(() => void refresh());
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { state, refresh };
}
