/**
 * Applies the user's appearance to the document and keeps it saved.
 *
 * - Token overrides become inline custom properties on <html>, which beat
 *   tokens.css, so every utility built on a token follows.
 * - Theme is the `.dark` class (shadcn convention). Increase contrast and
 *   reduce motion are `data-contrast="more"` and `data-motion="reduce"` on
 *   <html>, styled in ./overrides.css.
 * - The last applied appearance is cached in localStorage for an instant first
 *   paint; the vault's settings file is the source of truth and wins once read.
 * - Changes made in Settings apply at once and are saved after a short pause.
 */
import { getSettings, saveAppearance } from "@/lib/backend";
import { inTauri } from "@/lib/tauri";

import {
  DEFAULT_APPEARANCE,
  TOKEN_BY_NAME,
  cssProperties,
  isDefault,
  sanitizeAppearance,
  validateToken,
  type Appearance,
  type TokenValue,
} from "./tokens";

const CACHE_KEY = "steward.appearance.v1";
const SAVE_DELAY_MS = 450;

export type SystemPrefs = { dark: boolean; moreContrast: boolean; reduceMotion: boolean };
export type SaveState = { status: "idle" | "saving" | "saved" | "error"; error?: string; at: number };

let current: Appearance = DEFAULT_APPEARANCE;
let system: SystemPrefs = { dark: false, moreContrast: false, reduceMotion: false };
let saveState: SaveState = { status: "idle", at: 0 };
/** True while a local change has not reached the vault yet; the vault copy must not overwrite it. */
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let applied = new Set<string>();
let started = false;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export const getAppearance = (): Appearance => current;
export const getSystemPrefs = (): SystemPrefs => system;
export const getSaveState = (): SaveState => saveState;

/** What actually applies once "system" is resolved against the OS. */
export function effective(a: Appearance = current, s: SystemPrefs = system) {
  return {
    dark: a.theme === "dark" || (a.theme === "system" && s.dark),
    moreContrast: a.increaseContrast === "on" || (a.increaseContrast !== "off" && s.moreContrast),
    reduceMotion: a.reduceMotion === "on" || (a.reduceMotion !== "off" && s.reduceMotion),
  };
}

function apply(a: Appearance) {
  const root = document.documentElement;
  const e = effective(a);
  root.classList.toggle("dark", e.dark);
  root.dataset.themePref = a.theme;
  if (e.moreContrast) root.dataset.contrast = "more";
  else delete root.dataset.contrast;
  if (e.reduceMotion) root.dataset.motion = "reduce";
  else delete root.dataset.motion;

  const props = cssProperties(a);
  if (e.reduceMotion) {
    for (const k of ["--st-duration-fast", "--st-duration", "--st-duration-slow"]) props[k] = "0ms";
  }
  for (const name of applied) if (!(name in props)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(props)) root.style.setProperty(name, value);
  applied = new Set(Object.keys(props));
}

function cache(a: Appearance) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(a));
  } catch {
    // Storage can be unavailable (private mode, quota); the vault copy still loads.
  }
}

function readCache(): unknown {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setSaveState(s: Omit<SaveState, "at">) {
  saveState = { ...s, at: Date.now() };
  notify();
}

async function persistNow(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!inTauri()) {
    dirty = false;
    return;
  }
  const sent = current;
  setSaveState({ status: "saving" });
  try {
    await saveAppearance(sent);
    if (sent === current) dirty = false;
    setSaveState({ status: "saved" });
  } catch (e) {
    setSaveState({ status: "error", error: String(e) });
  }
}

/** Show an appearance without saving it (for example while hovering a choice). */
export function previewAppearance(a: Appearance): void {
  apply(sanitizeAppearance(a).appearance);
}

/** Put the saved (current) appearance back after a preview. */
export function endPreview(): void {
  apply(current);
}

/**
 * Change the appearance: validated, applied at once, cached, and saved to the
 * vault after a short pause so dragging a slider writes once.
 */
export function setAppearance(next: Appearance | ((prev: Appearance) => Appearance)): void {
  const raw = typeof next === "function" ? next(current) : next;
  current = sanitizeAppearance(raw).appearance;
  dirty = true;
  apply(current);
  cache(current);
  notify();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void persistNow(), SAVE_DELAY_MS);
}

/** Set one token. Invalid values are refused (returns the reason); out-of-range numbers are clamped. */
export function setToken(name: string, value: TokenValue): string | null {
  const r = validateToken(name, value);
  if (!r.ok) return r.error;
  const spec = TOKEN_BY_NAME.get(name)!;
  setAppearance((prev) => {
    const tokens = { ...prev.tokens };
    if (isDefault(spec, r.value)) delete tokens[name];
    else tokens[name] = r.value;
    return { ...prev, tokens };
  });
  return null;
}

export function resetTokens(names: readonly string[]): void {
  setAppearance((prev) => {
    const tokens = { ...prev.tokens };
    for (const n of names) delete tokens[n];
    return { ...prev, tokens };
  });
}

/** Save any pending change now (for example when Settings closes). */
export function flushAppearance(): Promise<void> {
  return saveTimer ? persistNow() : Promise.resolve();
}

function watchSystem() {
  const queries = {
    dark: window.matchMedia?.("(prefers-color-scheme: dark)"),
    moreContrast: window.matchMedia?.("(prefers-contrast: more)"),
    reduceMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)"),
  };
  const read = () => {
    system = {
      dark: !!queries.dark?.matches,
      moreContrast: !!queries.moreContrast?.matches,
      reduceMotion: !!queries.reduceMotion?.matches,
    };
  };
  read();
  for (const q of Object.values(queries)) {
    q?.addEventListener?.("change", () => {
      read();
      apply(current);
      notify();
    });
  }
}

/**
 * Apply the appearance before React renders: the cached copy first (no flash),
 * then the vault's copy once the core answers. Follows the system theme,
 * contrast and motion settings live while they are set to "system".
 */
export function startAppearance(): void {
  if (started) return;
  started = true;
  watchSystem();
  current = sanitizeAppearance(readCache()).appearance;
  apply(current);
  if (!inTauri()) return;
  getSettings().then(
    (s) => {
      if (dirty) return;
      const fromVault = sanitizeAppearance(s.appearance ?? {}).appearance;
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
