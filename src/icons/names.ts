/**
 * Every icon steward draws. Adding a name here makes it required in glyphs.tsx
 * (the type checker enforces it), so the set can never be half-drawn.
 */
export const ICON_NAMES = [
  // actions
  "plus", "close", "check", "copy", "edit", "retry", "more", "download", "search",
  "send", "stop", "attach", "remove", "play", "pause",
  // direction
  "chevron-down", "chevron-up", "chevron-left", "chevron-right", "arrow-down",
  // files and media
  "file", "file-text", "image", "image-off", "video", "audio", "folder",
  // agent
  "thinking", "tool", "agent", "spinner", "voice", "mic", "phone",
  // feedback and state
  "info", "warning", "error", "success", "shield", "lock", "key", "link",
  "thumbs-up", "thumbs-down",
  // app and window
  "settings", "appearance", "accessibility", "sidebar", "space", "user", "sun", "moon",
  "window-minimize", "window-maximize", "window-restore", "window-close",
] as const;

export type IconName = (typeof ICON_NAMES)[number];
