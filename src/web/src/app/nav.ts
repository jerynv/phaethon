import { create } from "zustand";

/**
 * Where the user is: the space, the view inside it, and the overlays on top.
 * Features navigate only through `useNav()`; the shell owns the
 * implementation and may extend this API but keeps these members.
 */

export type View =
  | { kind: "chat"; conversation?: string }
  | { kind: "study"; deck?: string; quiz?: string }
  | { kind: "grades"; course?: string }
  | { kind: "plan" }
  | { kind: "courses"; course?: string };

export type SettingsSection = "appearance" | "assistant" | "agents" | "spaces" | "courses" | "about";

type NavState = {
  spaceId: string;
  view: View;
  settings: SettingsSection | null;
  file: { spaceId: string; path: string } | null;
  go(view: View, spaceId?: string): void;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  openFile(path: string, spaceId?: string): void;
  closeFile(): void;
};

export const useNav = create<NavState>((set, get) => ({
  spaceId: "school",
  view: { kind: "chat" },
  settings: null,
  file: null,
  go: (view, spaceId) => set({ view, spaceId: spaceId ?? get().spaceId }),
  openSettings: (section = "appearance") => set({ settings: section }),
  closeSettings: () => set({ settings: null }),
  openFile: (path, spaceId) => set({ file: { path, spaceId: spaceId ?? get().spaceId } }),
  closeFile: () => set({ file: null }),
}));
