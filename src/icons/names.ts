/**
 * Semantic application names, each mapped to a Lucide component in index.tsx.
 * The type checker requires a mapping for every name.
 */
export const ICON_NAMES = [
  // actions
  "plus", "close", "check", "copy", "edit", "retry", "more", "download", "search",
  "send", "stop", "attach", "remove", "trash", "play", "pause",
  // direction
  "chevron-down", "chevron-up", "chevron-left", "chevron-right", "arrow-down",
  // files and media
  "file", "file-text", "file-plus", "image", "image-off", "video", "audio", "folder", "folder-plus", "book",
  // agent
  "thinking", "tool", "terminal", "agent", "chat", "new-chat", "spinner", "voice", "mic", "phone",
  // feedback and state
  "info", "warning", "error", "success", "shield", "lock", "key", "link",
  "thumbs-up", "thumbs-down",
  // app and window
  "settings", "appearance", "accessibility", "sidebar", "space", "user", "sun", "moon",
  "window-minimize", "window-maximize", "window-restore", "window-close",
] as const;

export type IconName = (typeof ICON_NAMES)[number];
