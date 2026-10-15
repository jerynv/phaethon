/**
 * Open the Settings window from anywhere (the title bar, Cmd+, / Ctrl+, , an
 * error banner, the grants popover), optionally at one section ("agent",
 * "appearance", "accessibility", "spaces", "courses", "about"). The settings dialog owns
 * its open state, listens for this event, and returns focus on close.
 * `space` (with "spaces") opens that space's details, focus on its name.
 */
export const OPEN_SETTINGS_EVENT = "phaethon:open-settings";

export function openSettings(section?: string, options?: { space?: string }): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { section, space: options?.space } }));
}
