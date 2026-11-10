import { isMac, modKey } from "../lib/platform";

/**
 * Every app-wide keyboard shortcut, in one place: the shell's key handler
 * matches with these, and buttons show their keys with `keysFor`.
 */
export type ShortcutId = "newChat" | "search" | "sidebar" | "settings" | "space" | "view" | "landmark";

/** True when the platform's command key (alone, without Alt) is held. */
function mod(e: KeyboardEvent): boolean {
  return isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Digit by key position, so it works on any layout and with Option on a Mac. */
function digit(e: KeyboardEvent, max: number): number | null {
  const m = /^Digit([1-9])$/.exec(e.code) ?? /^([1-9])$/.exec(e.key);
  const n = m ? Number(m[1]) : null;
  return n !== null && n <= max ? n : null;
}

export type ShortcutMatch =
  | { id: "newChat" | "search" | "sidebar" | "settings" }
  | { id: "space"; index: number }
  | { id: "view"; index: number }
  | { id: "landmark"; direction: 1 | -1 };

export function matchShortcut(e: KeyboardEvent): ShortcutMatch | null {
  if (e.key === "F6" && !e.altKey && !e.ctrlKey && !e.metaKey) return { id: "landmark", direction: e.shiftKey ? -1 : 1 };
  if (!mod(e) || e.getModifierState?.("AltGraph")) return null;
  const key = e.key.toLowerCase();
  if (e.altKey) {
    if (e.shiftKey) return null;
    const n = digit(e, 5);
    return n ? { id: "view", index: n - 1 } : null;
  }
  if (e.shiftKey) {
    if (key === "f") return { id: "search" };
    if (key === "o") return { id: "newChat" };
    return null;
  }
  if (key === "n") return { id: "newChat" };
  if (key === "k") return { id: "search" };
  if (key === "\\" || e.code === "Backslash" || key === "b") return { id: "sidebar" };
  if (key === "," || e.code === "Comma") return { id: "settings" };
  const n = digit(e, 9);
  if (n) return { id: "space", index: n - 1 };
  return null;
}

/** Keys to draw (one per key cap) and the aria-keyshortcuts value. */
export function keysFor(id: "newChat" | "search" | "sidebar" | "settings"): { keys: string[]; aria: string } {
  const m = modKey();
  switch (id) {
    case "newChat":
      return { keys: [m.cap, "N"], aria: `${m.aria}+N` };
    case "search":
      return { keys: [m.cap, "K"], aria: `${m.aria}+K` };
    case "sidebar":
      return { keys: [m.cap, "\\"], aria: `${m.aria}+Backslash` };
    case "settings":
      return { keys: [m.cap, ","], aria: `${m.aria}+Comma` };
  }
}

/** Views are ⌥⌘1–5 on a Mac and Ctrl+Alt+1–5 elsewhere. */
export function viewKeys(index: number): { keys: string[]; aria: string } {
  const n = index + 1;
  return isMac() ? { keys: ["⌥", "⌘", String(n)], aria: `Alt+Meta+${n}` } : { keys: ["Ctrl", "Alt", String(n)], aria: `Control+Alt+${n}` };
}

export function spaceKeys(index: number): { keys: string[]; aria: string } {
  const m = modKey();
  return { keys: [m.cap, String(index + 1)], aria: `${m.aria}+${index + 1}` };
}

/** A chord as one short string: "⌘3" on a Mac, "Ctrl+3" elsewhere. */
export function chordText(keys: string[]): string {
  return isMac() ? keys.join("") : keys.join("+");
}
