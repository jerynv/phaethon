import { create } from "zustand";
import { errorText } from "@/lib/core";
import { api, type SpaceView, type ThreadSummary } from "./api";

/**
 * Where the user is: the active space, the view inside it, the overlays
 * (settings, search, file viewer) and the conversation lists per space. The
 * core keeps one "current" conversation per space; opening another one makes
 * it current there, so the chat always shows the active space's current one.
 */

export type View = "chat" | "study" | "grades" | "plan" | "courses";
export type SettingsSection = "general" | "providers" | "agents" | "spaces" | "courses" | "appearance" | "about";

type Load<T> = { data?: T; error?: string; loading: boolean };

type Nav = {
  spaces: Load<SpaceView[]>;
  activeSpace: string | null;
  view: View;
  threads: Record<string, Load<ThreadSummary[]>>;
  collapsed: Record<string, boolean>;
  sidebarOpen: boolean;
  settings: SettingsSection | null;
  paletteOpen: boolean;
  viewer: { space: string; path: string } | null;
  /** Bumped when a conversation was opened or started, so the chat reloads. */
  threadEpoch: Record<string, number>;

  loadSpaces(): Promise<void>;
  selectSpace(id: string, view?: View): void;
  setView(view: View): void;
  loadThreads(space: string): Promise<void>;
  newChat(space: string): Promise<void>;
  openThread(space: string, id: string): Promise<void>;
  deleteThread(space: string, id: string): Promise<void>;
  toggleCollapsed(space: string): void;
  toggleSidebar(): void;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  setPalette(open: boolean): void;
  openFile(space: string, path: string): void;
  closeFile(): void;
};

const LAST_SPACE = "phaethon.lastSpace";
const COLLAPSED = "phaethon.collapsed";
const SIDEBAR = "phaethon.sidebar";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private window: preferences only last for the session.
  }
}

export const useNav = create<Nav>((set, get) => ({
  spaces: { loading: true },
  activeSpace: null,
  view: "chat",
  threads: {},
  collapsed: readJson<Record<string, boolean>>(COLLAPSED, {}),
  sidebarOpen: readJson<boolean>(SIDEBAR, true),
  settings: null,
  paletteOpen: false,
  viewer: null,
  threadEpoch: {},

  async loadSpaces() {
    set((s) => ({ spaces: { ...s.spaces, loading: true, error: undefined } }));
    try {
      const list = await api.spaces();
      const keep = get().activeSpace;
      const last = readJson<string | null>(LAST_SPACE, null);
      const pick = [keep, last].find((id) => id && list.some((s) => s.id === id)) ?? [...list].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))[0]?.id ?? null;
      set({ spaces: { data: list, loading: false }, activeSpace: pick });
      for (const s of list) void get().loadThreads(s.id);
    } catch (e) {
      set({ spaces: { loading: false, error: errorText(e) } });
    }
  },

  selectSpace(id, view) {
    const space = get().spaces.data?.find((s) => s.id === id);
    const next = view ?? (space?.educationEnabled ? get().view : "chat");
    set({ activeSpace: id, view: next, settings: null });
    writeJson(LAST_SPACE, id);
    void api.touchSpace(id).catch(() => {});
  },

  setView(view) {
    set({ view, settings: null });
  },

  async loadThreads(space) {
    set((s) => ({ threads: { ...s.threads, [space]: { ...s.threads[space], loading: true, error: undefined } } }));
    try {
      const list = await api.threads(space);
      set((s) => ({ threads: { ...s.threads, [space]: { data: list, loading: false } } }));
    } catch (e) {
      set((s) => ({ threads: { ...s.threads, [space]: { ...s.threads[space], loading: false, error: errorText(e) } } }));
    }
  },

  async newChat(space) {
    await api.newThread(space);
    get().selectSpace(space, "chat");
    set((s) => ({ threadEpoch: { ...s.threadEpoch, [space]: (s.threadEpoch[space] ?? 0) + 1 } }));
    await get().loadThreads(space);
  },

  async openThread(space, id) {
    if (id !== "current") await api.openThread(space, id);
    get().selectSpace(space, "chat");
    if (id !== "current") set((s) => ({ threadEpoch: { ...s.threadEpoch, [space]: (s.threadEpoch[space] ?? 0) + 1 } }));
    await get().loadThreads(space);
  },

  async deleteThread(space, id) {
    await api.deleteThread(space, id);
    if (id === "current") set((s) => ({ threadEpoch: { ...s.threadEpoch, [space]: (s.threadEpoch[space] ?? 0) + 1 } }));
    await get().loadThreads(space);
  },

  toggleCollapsed(space) {
    const collapsed = { ...get().collapsed, [space]: !get().collapsed[space] };
    set({ collapsed });
    writeJson(COLLAPSED, collapsed);
  },

  toggleSidebar() {
    const open = !get().sidebarOpen;
    set({ sidebarOpen: open });
    writeJson(SIDEBAR, open);
  },

  openSettings(section = "general") {
    set({ settings: section, paletteOpen: false });
  },
  closeSettings() {
    set({ settings: null });
  },
  setPalette(open) {
    set({ paletteOpen: open });
  },
  openFile(space, path) {
    set({ viewer: { space, path } });
  },
  closeFile() {
    set({ viewer: null });
  },
}));

export const NO_SPACES: SpaceView[] = [];

export function useActiveSpace(): SpaceView | undefined {
  return useNav((s) => s.spaces.data?.find((x) => x.id === s.activeSpace));
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__phaethon = { ...(window.__phaethon ?? {}), nav: useNav };
}
