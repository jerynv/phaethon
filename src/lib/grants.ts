import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

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

/**
 * A grant into a space: another space (`to`) may read `path` in it. Mirrors
 * the `incoming` entries of `GrantsView`.
 */
export interface IncomingGrantView {
  id: string;
  /** The space that reads. */
  to: string;
  path: string;
  /** ISO 8601, UTC. */
  created: string;
  scope: "always" | "once";
}

/**
 * Mirrors `GrantsView`: what one space may read, which spaces may read it
 * (`incoming`; missing from an older core), plus notes on ignored entries in
 * grants.json.
 */
export interface GrantsView {
  grants: GrantView[];
  incoming?: IncomingGrantView[];
  problems: string[];
}

/** Grants where `to == space`, and those where `from == space`. Rejects with a message for an invalid space. */
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

// ---- Revoke with Undo ----
// A revoke from the title bar waits a few seconds before it is made, so it can
// be undone (grants cannot be re-created from the UI). Until then the grant
// still stands; the pending state lives here, outside any component, so it is
// committed even if the popover closes or the space changes.

/** How long a revoke can be undone, in milliseconds. */
export const UNDO_MS = 6000;

type Pending = { timer: ReturnType<typeof setTimeout>; commit: () => Promise<void>; committing: boolean };
const pending = new Map<string, Pending>();
// Revoked here and gone from grants.json; hidden at once, before the list reloads.
const revoked = new Set<string>();
let snapshot: { pending: ReadonlySet<string>; revoked: ReadonlySet<string> } = { pending: new Set(), revoked: new Set() };
const pendingListeners = new Set<() => void>();
function publishPending() {
  snapshot = { pending: new Set(pending.keys()), revoked: new Set(revoked) };
  pendingListeners.forEach((l) => l());
}

/**
 * Revoke `id` after `ms` unless undone. `done` gets the result when it is
 * made (removed true; false when it was already gone) or the error. `done`
 * runs before the views redraw, so it can still see where focus was.
 */
export function scheduleRevoke(id: string, done: (result: { removed: boolean } | { error: unknown }) => void, ms = UNDO_MS): void {
  if (pending.has(id)) return;
  const commit = async () => {
    const p = pending.get(id);
    if (!p || p.committing) return;
    p.committing = true;
    clearTimeout(p.timer);
    let result: { removed: boolean } | { error: unknown };
    try {
      result = { removed: await revokeGrant(id) };
      revoked.add(id);
    } catch (error) {
      result = { error };
    }
    pending.delete(id);
    done(result);
    publishPending();
  };
  pending.set(id, { timer: setTimeout(() => void commit(), ms), commit, committing: false });
  publishPending();
}

/** Cancel a pending revoke. True when there was one to cancel (false once it is being made). */
export function undoRevoke(id: string): boolean {
  const p = pending.get(id);
  if (!p || p.committing) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  publishPending();
  return true;
}

/** Make every pending revoke now (the window is closing: never leave one undone silently). */
export function commitPendingRevokes(): void {
  for (const p of [...pending.values()]) void p.commit();
}
if (typeof window !== "undefined") window.addEventListener("pagehide", commitPendingRevokes);

/** Ids of grants whose revoke is waiting out its Undo time. */
/** `pending`: revokes waiting out their Undo time; `revoked`: revokes made here (hide those rows). */
export function usePendingRevokes(): { pending: ReadonlySet<string>; revoked: ReadonlySet<string> } {
  return useSyncExternalStore(
    (cb) => {
      pendingListeners.add(cb);
      return () => pendingListeners.delete(cb);
    },
    () => snapshot,
  );
}

// ---- Presentation helpers ----

/** Most recent first; an unreadable date sorts last. Stable for equal dates. */
export function byRecent<T extends { created: string }>(list: readonly T[]): T[] {
  const t = (g: T) => {
    const n = new Date(g.created).getTime();
    return Number.isNaN(n) ? -Infinity : n;
  };
  return list.map((g, i) => ({ g, i })).sort((a, b) => t(b.g) - t(a.g) || a.i - b.i).map(({ g }) => g);
}

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
export function grantNoun(grants: readonly { path: string }[], plural: boolean): string {
  const isFile = (g: { path: string }) => /\.[^/]+$/.test(g.path.split("/").pop() ?? "");
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
  | { status: "ready"; grants: GrantView[]; incoming: IncomingGrantView[]; problems: string[] }
  | { status: "error"; error: string };

const EMPTY: GrantsState = { status: "ready", grants: [], incoming: [], problems: [] };

/**
 * What `space` may read in other spaces, and who may read it (both most
 * recent first), kept fresh: reloads when the space
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
      setState({ status: "ready", grants: byRecent(v.grants ?? []), incoming: byRecent(v.incoming ?? []), problems: v.problems ?? [] });
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
