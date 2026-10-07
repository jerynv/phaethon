import { useSyncExternalStore } from "react";

/**
 * Whether code blocks wrap long lines: one choice for every code block,
 * changed from any block's "Wrap lines" button and remembered on this device.
 * Until it is chosen, code wraps when the text size is 125% or more (at large
 * text, a sideways scroll in every block is the harder way to read).
 */
const KEY = "phaethon:code-wrap";
const listeners = new Set<() => void>();
let chosen: boolean | null = read();

function read(): boolean | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "on" ? true : v === "off" ? false : null;
  } catch {
    return null;
  }
}

function textScale(): number {
  if (typeof document === "undefined") return 1;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ph-text-scale"));
  return Number.isFinite(v) ? v : 1;
}

const snapshot = () => chosen ?? textScale() >= 1.25;
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function setCodeWrap(on: boolean) {
  chosen = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Not saved (private window): it still applies until the app closes.
  }
  listeners.forEach((l) => l());
}

export function useCodeWrap(): boolean {
  return useSyncExternalStore(subscribe, snapshot);
}
