import { useSyncExternalStore } from "react";
import { errorText, invoke } from "@/lib/core";
import {
  DEFAULT_APPEARANCE,
  dials,
  effective,
  sanitizeAppearance,
  type Appearance,
  type SystemPrefs,
} from "@/lib/appearance-model";

/**
 * Applies the person's appearance to <html> and keeps it saved.
 *
 * - The last applied copy is cached in localStorage; public/appearance-boot.js
 *   applies it before the first paint, so there is no flash.
 * - The vault's settings file is the source of truth and wins once read,
 *   unless a change made here hasn't been saved yet.
 * - A change applies at once and is saved after a short pause, so stepping
 *   through choices writes once.
 */

export const APPEARANCE_CACHE_KEY = "phaethon.appearance.v1";
export const SPACE_HUE_CACHE_KEY = "phaethon.space-hue";
const SAVE_DELAY_MS = 400;

export type SaveState = { status: "idle" | "saving" | "saved" | "error"; error?: string };

let current: Appearance = DEFAULT_APPEARANCE;
let system: SystemPrefs = { dark: false, moreContrast: false, reduceMotion: false };
let saveState: SaveState = { status: "idle" };
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let snapshot = { appearance: current, system, saveState };
const listeners = new Set<() => void>();

function notify() {
  snapshot = { appearance: current, system, saveState };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getAppearance(): Appearance {
  return current;
}

export function useAppearance() {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

function apply(a: Appearance) {
  const root = document.documentElement;
  const e = effective(a, system);
  const d = dials(a);
  root.classList.toggle("dark", e.dark);
  if (e.moreContrast) root.dataset.contrast = "more";
  else delete root.dataset.contrast;
  if (e.reduceMotion) root.dataset.motion = "reduce";
  else delete root.dataset.motion;
  if (a.readingFont !== "atkinson") root.dataset.font = a.readingFont;
  else delete root.dataset.font;
  root.dataset.focusRings = d.focusRings ? "on" : "off";
  if (d.largeTargets) root.dataset.targets = "large";
  else delete root.dataset.targets;
  root.style.setProperty("--ph-text-scale", String(d.textScale));
  root.style.setProperty("--ph-leading", String(d.leading));
  root.style.setProperty("--ph-tracking", `${d.tracking}em`);
  root.style.setProperty("--ph-word-spacing", `${d.wordSpacing}em`);
}

function cache(a: Appearance) {
  try {
    localStorage.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(a));
  } catch {
    // Storage can be unavailable; the vault copy still loads.
  }
}

function readCache(): unknown {
  try {
    const raw = localStorage.getItem(APPEARANCE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function persistNow(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const sent = current;
  saveState = { status: "saving" };
  notify();
  try {
    await invoke("appearance_set", { appearance: sent });
    if (sent === current) dirty = false;
    saveState = { status: "saved" };
  } catch (e) {
    saveState = { status: "error", error: errorText(e) };
  }
  notify();
}

/** Changes the appearance: applied at once, cached, saved to the vault shortly after. */
export function setAppearance(next: Appearance | ((prev: Appearance) => Appearance)): void {
  current = sanitizeAppearance(typeof next === "function" ? next(current) : next);
  dirty = true;
  apply(current);
  cache(current);
  notify();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void persistNow(), SAVE_DELAY_MS);
}

/** Saves a pending change now (Settings closing). */
export function flushAppearance(): Promise<void> {
  return saveTimer ? persistNow() : Promise.resolve();
}

/** The current space's hue, for the accent colour; cached so the next launch starts in it. */
export function applySpaceHue(hue: number | undefined): void {
  if (hue === undefined || !Number.isFinite(hue)) return;
  document.documentElement.style.setProperty("--space-hue", String(Math.round(hue)));
  try {
    localStorage.setItem(SPACE_HUE_CACHE_KEY, String(Math.round(hue)));
  } catch {
    // Not essential.
  }
}

function watchSystem() {
  const q = (s: string) => (typeof window.matchMedia === "function" ? window.matchMedia(s) : undefined);
  const queries = {
    dark: q("(prefers-color-scheme: dark)"),
    moreContrast: q("(prefers-contrast: more)"),
    reduceMotion: q("(prefers-reduced-motion: reduce)"),
  };
  const read = () => {
    system = {
      dark: !!queries.dark?.matches,
      moreContrast: !!queries.moreContrast?.matches,
      reduceMotion: !!queries.reduceMotion?.matches,
    };
  };
  read();
  for (const query of Object.values(queries)) {
    query?.addEventListener?.("change", () => {
      read();
      apply(current);
      notify();
    });
  }
}

/**
 * Applies the cached appearance at once, then the vault's copy once the core
 * answers. Follows the OS live wherever a preference is "system".
 */
export function startAppearance(): void {
  if (started) return;
  started = true;
  watchSystem();
  current = sanitizeAppearance(readCache());
  apply(current);
  notify();
  invoke<{ appearance?: unknown }>("settings_get").then(
    (s) => {
      if (dirty) return;
      const fromVault = sanitizeAppearance(s.appearance ?? {});
      if (JSON.stringify(fromVault) !== JSON.stringify(current)) {
        current = fromVault;
        apply(current);
        notify();
      }
      cache(current);
    },
    () => {
      // Keep the cached appearance; Settings reports load errors itself.
    },
  );
}
