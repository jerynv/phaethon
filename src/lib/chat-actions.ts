/**
 * The buttons a reply can put under itself with a ```phaethon-actions block,
 * one id per line (src-tauri/src/app_guide.rs tells the assistant which ids
 * there are). Only ids listed here are drawn, with the app's own words and
 * icon, so a reply can't make a button say one thing and do another.
 */
import type { IconName } from "@/icons";

export const ACTIONS_FENCE = "phaethon-actions";

export const CHAT_ACTION_IDS = [
  "add-files",
  "add-folder",
  "attach-files",
  "show-folder",
  "import-courses",
  "new-space",
  "settings-assistant",
  "settings-appearance",
  "settings-accessibility",
  "settings-spaces",
  "settings-courses",
  "settings-about",
] as const;

export type ChatActionId = (typeof CHAT_ACTION_IDS)[number];

/** Settings sections by action id (open-settings.ts). */
export const SETTINGS_SECTION: Partial<Record<ChatActionId, string>> = {
  "settings-assistant": "agent",
  "settings-appearance": "appearance",
  "settings-accessibility": "accessibility",
  "settings-spaces": "spaces",
  "settings-courses": "courses",
  "settings-about": "about",
};

export function actionLabel(id: ChatActionId, fileManager: string): { label: string; icon: IconName } {
  switch (id) {
    case "add-files":
      return { label: "Add files…", icon: "file-plus" };
    case "add-folder":
      return { label: "Add a folder…", icon: "folder-plus" };
    case "attach-files":
      return { label: "Attach files…", icon: "attach" };
    case "show-folder":
      return { label: `Show in ${fileManager}`, icon: "folder" };
    case "import-courses":
      return { label: "Import courses…", icon: "book" };
    case "new-space":
      return { label: "New space…", icon: "space" };
    case "settings-assistant":
      return { label: "Settings: Assistant", icon: "agent" };
    case "settings-appearance":
      return { label: "Settings: Appearance", icon: "appearance" };
    case "settings-accessibility":
      return { label: "Settings: Accessibility", icon: "accessibility" };
    case "settings-spaces":
      return { label: "Settings: Spaces", icon: "space" };
    case "settings-courses":
      return { label: "Settings: Course sites", icon: "book" };
    case "settings-about":
      return { label: "Settings: About", icon: "info" };
  }
}

const KNOWN = new Set<string>(CHAT_ACTION_IDS);
export const MAX_ACTIONS = 3;

/**
 * The ids in a block, in its order: one per line (a JSON list, commas or
 * spaces also do), unknown ones and repeats dropped, at most three.
 */
export function readActions(code: string): ChatActionId[] {
  const words = code
    .replace(/[[\]"'`,]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  const out: ChatActionId[] = [];
  for (const w of words) {
    if (KNOWN.has(w) && !out.includes(w as ChatActionId)) out.push(w as ChatActionId);
    if (out.length === MAX_ACTIONS) break;
  }
  return out;
}

/** Asks the composer of `space` to open its file picker (composer.tsx listens). */
export const ATTACH_FILES_EVENT = "phaethon:attach-files";
/** Asks the app to open New space (App.tsx listens). */
export const NEW_SPACE_EVENT = "phaethon:new-space";
