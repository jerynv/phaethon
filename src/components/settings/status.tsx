import { createContext, useContext } from "react";

/**
 * The settings window's one status line. `say` puts a short confirmation in a
 * polite live region ("Text size reset."); `fail` shows an error as an alert.
 */
export type SettingsStatus = { say: (message: string) => void; fail: (message: string) => void };

export const StatusContext = createContext<SettingsStatus>({ say: () => {}, fail: () => {} });

export const useStatus = () => useContext(StatusContext);

export type SectionId = "agent" | "appearance" | "accessibility" | "spaces" | "about";

/**
 * Move to another settings section from inside a page ("Text size is in
 * Accessibility"), then focus `focus` (a selector) in the new page, or its
 * heading when that is not found.
 */
export type SettingsNav = { go: (section: SectionId, focus?: string) => void };

export const NavContext = createContext<SettingsNav>({ go: () => {} });

export const useSettingsNav = () => useContext(NavContext);
