import { isMac, modKey } from "../lib/platform";

/**
 * Every app-wide keyboard shortcut, in one place: the shell's key handler
 * matches with these, and buttons show their keys with `keysFor`.
 */
export type ShortcutId = "newChat" | "search" | "sidebar" | "settings" | "space" | "view" | "landmark" | "closeTab" | "reopenTab" | "cycleTab";

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
  | { id: "landmark"; direction: 1 | -1 }
  | { id: "closeTab" | "reopenTab" }
  | { id: "cycleTab"; direction: 1 | -1 };

export function matchShortcut(e: KeyboardEvent): ShortcutMatch | null {
  if (e.key === "F6" && !e.altKey && !e.ctrlKey && !e.metaKey) return { id: "landmark", direction: e.shiftKey ? -1 : 1 };
  // Ctrl+Tab walks the open tabs on every platform, as in a browser.
  if (e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) return { id: "cycleTab", direction: e.shiftKey ? -1 : 1 };
  if (!mod(e) || e.getModifierState?.("AltGraph")) return null;
  const key = e.key.toLowerCase();
  if (e.altKey) {
    if (e.shiftKey) return null;
    if (e.key === "ArrowRight") return { id: "cycleTab", direction: 1 };
    if (e.key === "ArrowLeft") return { id: "cycleTab", direction: -1 };
    // Chat, Files, Study, Grades, Plan, Courses (app/views.tsx).
    const n = digit(e, 6);
    return n ? { id: "view", index: n - 1 } : null;
  }
  if (e.shiftKey) {
    if (key === "f") return { id: "search" };
    if (key === "o") return { id: "newChat" };
    if (key === "t") return { id: "reopenTab" };
    return null;
  }
  if (key === "w") return { id: "closeTab" };
  if (key === "n") return { id: "newChat" };
  if (key === "k") return { id: "search" };
  if (key === "\\" || e.code === "Backslash" || key === "b") return { id: "sidebar" };
  if (key === "," || e.code === "Comma") return { id: "settings" };
  const n = digit(e, 9);
  if (n) return { id: "space", index: n - 1 };
  return null;
}

/** Keys to draw (one per key cap) and the aria-keyshortcuts value. */
export function keysFor(id: "newChat" | "search" | "sidebar" | "settings" | "closeTab" | "reopenTab"): { keys: string[]; aria: string } {
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
    case "closeTab":
      return { keys: [m.cap, "W"], aria: `${m.aria}+W` };
    case "reopenTab":
      return { keys: [isMac() ? "⇧" : "Shift", m.cap, "T"], aria: `Shift+${m.aria}+T` };
  }
}

/** Views are ⌥⌘1–6 on a Mac and Ctrl+Alt+1–6 elsewhere. */
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
