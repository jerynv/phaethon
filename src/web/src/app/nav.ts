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

/** What a space is doing, for the sidebar: replying, or waiting on the person (approval, question). */
export type Activity = "answering" | "needsYou";

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
  /** Bumped when the current conversation changed outside the chat (opened, new, deleted): the chat reloads. */
  threadVersion: number;
  bumpThread(): void;
  /** Bumped when the conversation list may have changed (a turn ended, a title changed): the sidebar reloads. */
  threadListVersion: number;
  bumpThreadList(): void;
  activity: Record<string, Activity | undefined>;
  setActivity(spaceId: string, activity: Activity | undefined): void;
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
  threadVersion: 0,
  bumpThread: () => set((s) => ({ threadVersion: s.threadVersion + 1 })),
  threadListVersion: 0,
  bumpThreadList: () => set((s) => ({ threadListVersion: s.threadListVersion + 1 })),
  activity: {},
  setActivity: (spaceId, activity) => set((s) => ({ activity: { ...s.activity, [spaceId]: activity } })),
}));
