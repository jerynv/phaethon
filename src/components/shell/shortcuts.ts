import { platform } from "@/lib/platform";

/**
 * Every keyboard shortcut Phaethon has, in one place: the Shortcuts sheet
 * lists these, and the command palette shows the matching ones beside its
 * commands. `keys` is what is shown (one entry per key cap); `aria` is the
 * aria-keyshortcuts value.
 */
export type Shortcut = { id: string; does: string; keys: string[]; aria?: string };
export type ShortcutGroup = { title: string; shortcuts: Shortcut[] };

const mac = () => platform() === "mac";
/** The command key's cap: ⌘ on a Mac, Ctrl elsewhere. */
export const modCap = () => (mac() ? "⌘" : "Ctrl");
/** The command key in aria-keyshortcuts. */
export const modAria = () => (mac() ? "Meta" : "Control");

/** True when the platform's command key (alone, with no Alt or Shift) is held. */
export function isModChord(e: KeyboardEvent): boolean {
  const mod = mac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.altKey && !e.shiftKey;
}

/** 1 to 9 for Cmd+1…9 (by the key's position, so it works on any layout), or null. */
export function digitOf(e: KeyboardEvent): number | null {
  const m = /^Digit([1-9])$/.exec(e.code) ?? /^([1-9])$/.exec(e.key);
  return m ? Number(m[1]) : null;
}

export function shortcutGroups(): ShortcutGroup[] {
  const m = modCap();
  const a = modAria();
  return [
    {
      title: "Anywhere",
      shortcuts: [
        { id: "palette", does: "Find a space or command", keys: [m, "K"], aria: `${a}+K` },
        { id: "spaces", does: "Go to space 1 to 9 (in the sidebar’s order)", keys: [m, "1…9"], aria: `${a}+1` },
        { id: "new", does: "New conversation", keys: [m, "N"], aria: `${a}+N` },
        { id: "sidebar", does: "Show or hide the sidebar", keys: [m, "\\"], aria: `${a}+Backslash` },
        { id: "settings", does: "Settings", keys: [m, ","], aria: `${a}+Comma` },
        { id: "shortcuts", does: "Keyboard shortcuts (this list)", keys: [m, "/"], aria: `${a}+Slash` },
      ],
    },
    {
      title: "Writing a message",
      shortcuts: [
        { id: "send", does: "Send", keys: ["Enter"] },
        { id: "newline", does: "New line", keys: ["Shift", "Enter"] },
        { id: "stop", does: "Stop the reply", keys: ["Esc"] },
      ],
    },
    {
      title: "Sidebar",
      shortcuts: [
        { id: "move", does: "Move between spaces", keys: ["↑", "↓"] },
        { id: "ends", does: "First or last space", keys: ["Home", "End"] },
        { id: "close", does: "Close the sidebar (narrow window)", keys: ["Esc"] },
      ],
    },
  ];
}

/** One shortcut by id, for showing beside a command. */
export function shortcutById(id: string): Shortcut | undefined {
  for (const g of shortcutGroups()) for (const s of g.shortcuts) if (s.id === id) return s;
  return undefined;
}
