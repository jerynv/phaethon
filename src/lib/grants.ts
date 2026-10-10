import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

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

/** A revoked grant as it was, to keep showing its row (with Undo) until the Undo time is over. */
type Known = { id: string; to: string; from: string; path: string; created: string };
const known = new Map<string, Known>();

/** Grants where `to == space`, and those where `from == space`. Rejects with a message for an invalid space. */
export async function listGrants(space: string): Promise<GrantsView> {
  const view = await invoke<GrantsView>("grants_list", { space });
  for (const g of view.grants) known.set(g.id, { id: g.id, to: space, from: g.from, path: g.path, created: g.created });
  for (const g of view.incoming ?? []) known.set(g.id, { id: g.id, to: g.to, from: space, path: g.path, created: g.created });
  return view;
}

/** Put a just-revoked grant back (Undo). Only the id goes: the core restores what it removed. */
async function restoreGrant(k: Known): Promise<void> {
  try {
    await invoke("grant_restore", { id: k.id });
  } finally {
    notifyGrantsChanged();
  }
}

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
// A revoke is made at once: the grant stops working the moment the user says
// so. The row then offers Undo, which puts the same grant back (same id and
// date), until the view that offered it closes (it calls commitRevokes) or
// UNDO_MS passes. Undo is never taken away on a short timer while the user is
// still looking at it: someone who needs time to reach a button must not lose
// it. The state lives here, outside any component, so it survives the space
// changing.

/**
 * The longest a revoke can be undone, in milliseconds: just under the ten
 * minutes the core keeps a revoked grant for `grant_restore`, so an Undo that
 * is shown always works. Views end it sooner, when they close.
 */
export const UNDO_MS = 9 * 60_000;

/** `finish` ends the Undo time; asked for before the revoke has answered, it only marks it `ended`, and the answer finishes it. */
type Pending = { timer: ReturnType<typeof setTimeout>; grant: Known | undefined; finish: () => void; ended: boolean };
const pending = new Map<string, Pending>();
// Revoked here and gone from grants.json; hidden at once, before the list reloads.
const revoked = new Set<string>();
// Undone here and being put back; shown until a reloaded list has them, so the row (and focus on it) never drops out.
const restoring = new Map<string, Known>();
type Snapshot = { pending: ReadonlySet<string>; revoked: ReadonlySet<string>; restoring: ReadonlySet<string> };
let snapshot: Snapshot = { pending: new Set(), revoked: new Set(), restoring: new Set() };
const pendingListeners = new Set<() => void>();
function publishPending() {
  snapshot = { pending: new Set(pending.keys()), revoked: new Set(revoked), restoring: new Set(restoring.keys()) };
  pendingListeners.forEach((l) => l());
}

/**
 * Revoke `id` now and offer Undo until commitRevokes([id]) (the view closing)
 * or `ms`, whichever is first. `done` gets the result when the Undo time is
 * over (removed true; false when it was already gone), or the error at once if
 * the revoke failed. `done` runs before the views redraw.
 */
export function scheduleRevoke(id: string, done: (result: { removed: boolean } | { error: unknown }) => void, ms = UNDO_MS): void {
  if (pending.has(id)) return;
  const grant = known.get(id);
  const entry: Pending = {
    timer: setTimeout(() => entry.finish(), ms),
    grant,
    ended: false,
    finish: () => {
      entry.ended = true;
    },
  };
  pending.set(id, entry);
  publishPending();
  void revokeGrant(id).then(
    (removed) => {
      entry.finish = () => {
        if (pending.get(id) !== entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        revoked.add(id);
        done({ removed });
        publishPending();
      };
      // Nothing to put back if it was already gone, or if Undo can't know what it was;
      // and nothing to wait for if the view already closed.
      if (!removed || !grant || entry.ended) entry.finish();
    },
    (error) => {
      clearTimeout(entry.timer);
      pending.delete(id);
      done({ error });
      publishPending();
    },
  );
}

/** Undo a revoke still waiting out its Undo time: the same grant is put back. True when there was one to undo. */
export function undoRevoke(id: string): boolean {
  const p = pending.get(id);
  if (!p || !p.grant) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  restoring.set(id, p.grant);
  publishPending();
  void restoreGrant(p.grant).catch((e: unknown) => {
    console.error("grant_restore failed:", e);
    restoring.delete(id);
    publishPending();
  });
  return true;
}

/**
 * End the Undo time of these revokes now (the view that offered Undo is
 * closing). The revokes are already made; their rows go. Ids with no Undo
 * waiting are ignored.
 */
export function commitRevokes(ids: Iterable<string>): void {
  for (const id of ids) pending.get(id)?.finish();
}

/** End every Undo window now (the window is closing). The revokes are already made. */
export function commitPendingRevokes(): void {
  for (const p of [...pending.values()]) p.finish();
}
if (typeof window !== "undefined") window.addEventListener("pagehide", commitPendingRevokes);

/**
 * An undone revoke is back in grants.json once a list shows it: stop standing
 * in for it. Call in the same tick as the state update that shows the list,
 * so no render has the row from neither.
 */
function forgetRestored(view: GrantsView) {
  let back = false;
  for (const g of [...view.grants, ...(view.incoming ?? [])]) back = restoring.delete(g.id) || back;
  if (back) publishPending();
}

/** `pending`: revokes waiting out their Undo time; `revoked`: revokes made here (hide those rows); `restoring`: undone, being put back. */
export function usePendingRevokes(): Snapshot {
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
      forgetRestored(v);
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

  // A grant revoked but still undoable is gone from grants.json but keeps
  // its row (with Undo) until its Undo time is over; an undone one keeps it
  // until the reloaded list has it again.
  const { pending: waiting, restoring: back } = usePendingRevokes();
  const shown = useMemo<GrantsState>(() => {
    if (state.status !== "ready" || waiting.size + back.size === 0) return state;
    const grants = [...state.grants];
    const incoming = [...state.incoming];
    for (const id of [...waiting, ...back]) {
      const k = pending.get(id)?.grant ?? restoring.get(id);
      if (!k) continue;
      if (k.to === space && !grants.some((g) => g.id === id)) grants.push({ id, from: k.from, path: k.path, created: k.created, scope: "always" });
      if (k.from === space && !incoming.some((g) => g.id === id)) incoming.push({ id, to: k.to, path: k.path, created: k.created, scope: "always" });
    }
    return { ...state, grants: byRecent(grants), incoming: byRecent(incoming) };
  }, [state, waiting, back, space]);

  return { state: shown, refresh };
}
