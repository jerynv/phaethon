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

/** True when the command key and Shift (no Alt) are held: Cmd+Shift+F and the like. */
export function isModShiftChord(e: KeyboardEvent): boolean {
  const mod = mac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && e.shiftKey && !e.altKey;
}

/** 1 to 9 for Cmd+1…9 (by the key's position, so it works on any layout), or null. */
export function digitOf(e: KeyboardEvent): number | null {
  const m = /^Digit([1-9])$/.exec(e.code) ?? /^([1-9])$/.exec(e.key);
  return m ? Number(m[1]) : null;
}

/** The view shortcut's caps: ⌥⌘1…4 on a Mac, Ctrl+Alt+1…4 elsewhere. */
export function viewChord(digit: number | "1…4"): { keys: string[]; aria: string } {
  const n = digit === "1…4" ? 1 : digit;
  return mac() ? { keys: ["⌥", "⌘", String(digit)], aria: `Alt+Meta+${n}` } : { keys: ["Ctrl", "Alt", String(digit)], aria: `Control+Alt+${n}` };
}

/**
 * 1 to 4 for the view shortcuts (Chat, Study, Grades, Plan), or null. By the key's position (Option
 * changes the character on a Mac). AltGr (Ctrl+Alt where a layout types with it) is never taken.
 */
export function viewDigitOf(e: KeyboardEvent): number | null {
  const mod = mac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || !e.altKey || e.shiftKey || e.getModifierState?.("AltGraph")) return null;
  const m = /^Digit([1-4])$/.exec(e.code);
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
        { id: "spaces", does: "Go to space 1 to 9 (in the sidebar’s order: the most recently used first)", keys: [m, "1…9"], aria: `${a}+1` },
        { id: "views", does: "Chat, Study, Grades or Plan, in the space on screen", ...viewChord("1…4") },
        { id: "new", does: "New conversation", keys: [m, "N"], aria: `${a}+N` },
        { id: "search", does: "Search conversations", keys: [m, "Shift", "F"], aria: `${a}+Shift+F` },
        { id: "wide", does: "Wide reading on or off", keys: [m, "Shift", "L"], aria: `${a}+Shift+L` },
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
        { id: "card", does: "Go to the question waiting for your answer (Allow, or access to another space)", keys: [mac() ? "⌥" : "Alt", "Enter"] },
        { id: "card-allow", does: "On that question: allow", keys: [m, "Enter"], aria: `${a}+Enter` },
        { id: "card-refuse", does: "On that question: don’t allow", keys: [m, mac() ? "⌫" : "Backspace"], aria: `${a}+Backspace` },
        { id: "edit-last", does: "Edit your last message (in an empty message box)", keys: ["↑"] },
      ],
    },
    {
      title: "Studying cards",
      shortcuts: [
        { id: "flip", does: "Show the answer", keys: ["Space"] },
        { id: "rate", does: "How well you knew it, from 1 (not at all) to 5 (perfectly)", keys: ["1…5"] },
        { id: "quiz-choice", does: "In a quiz question: move between the answers", keys: ["↑", "↓"] },
      ],
    },
    {
      title: "Conversations menu",
      shortcuts: [
        { id: "conv-delete", does: "Delete the conversation you’re on (asks first)", keys: [mac() ? "⌫" : "Delete"], aria: mac() ? "Backspace" : "Delete" },
        { id: "conv-delete-button", does: "Go to a conversation’s Delete button, and back", keys: ["→", "←"] },
      ],
    },
    {
      title: "Sidebar",
      shortcuts: [
        { id: "move", does: "Move between spaces", keys: ["↑", "↓"] },
        { id: "ends", does: "First or last space", keys: ["Home", "End"] },
        { id: "space-menu", does: `A space’s menu (Show in ${mac() ? "Finder" : platform() === "windows" ? "File Explorer" : "Files"}, Export…)`, keys: ["Shift", "F10"], aria: "Shift+F10" },
        { id: "space-more", does: "Go to a space’s More button, and back", keys: ["→", "←"] },
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
