/**
 * The buttons a reply can put under itself with a ```phaethon-actions block,
 * one id per line (the core's app guide tells the assistant which ids exist).
 * Only ids listed here are drawn, with the app's own words, so a reply can't
 * make a button say one thing and do another.
 */

export const ACTIONS_FENCE = "phaethon-actions";

/** Must equal the core's app-guide ACTIONS, in the same order. */
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

/** Settings sections (useNav's SettingsSection) by action id. Accessibility lives with Appearance. */
export const SETTINGS_SECTION: Partial<Record<ChatActionId, "assistant" | "appearance" | "spaces" | "courses" | "about">> = {
  "settings-assistant": "assistant",
  "settings-appearance": "appearance",
  "settings-accessibility": "appearance",
  "settings-spaces": "spaces",
  "settings-courses": "courses",
  "settings-about": "about",
};

export function actionLabel(id: ChatActionId, fileManager: string): string {
  switch (id) {
    case "add-files":
      return "Add files…";
    case "add-folder":
      return "Add a folder…";
    case "attach-files":
      return "Attach files…";
    case "show-folder":
      return `Show in ${fileManager}`;
    case "import-courses":
      return "Import courses…";
    case "new-space":
      return "New space…";
    case "settings-assistant":
      return "Settings: Assistant";
    case "settings-appearance":
    case "settings-accessibility":
      return "Settings: Appearance & accessibility";
    case "settings-spaces":
      return "Settings: Spaces";
    case "settings-courses":
      return "Settings: Courses";
    case "settings-about":
      return "Settings: About";
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

/** The platform's file manager, in its own words. */
export function fileManagerName(platform: string = typeof navigator === "undefined" ? "" : navigator.platform): string {
  const p = platform.toLowerCase();
  if (p.includes("mac")) return "Finder";
  if (p.includes("win")) return "File Explorer";
  return "Files";
}
