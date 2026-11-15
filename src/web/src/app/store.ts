import { create } from "zustand";
import { errorText } from "@/lib/core";
import { api, type SpaceView, type ThreadListed } from "./api";

/**
 * Where the user is: the active space, the view inside it, the overlays
 * (settings, search, file viewer), the conversation lists per space and which
 * conversation each space shows. Every conversation is addressed by its id,
 * and several can reply at once; opening one never touches the core. A space
 * can instead show its new chat (`DRAFT`), which becomes a conversation only
 * when it is first sent (features/chat/store.ts).
 */

export type View = "chat" | "study" | "grades" | "plan" | "courses";
export type SettingsSection = "general" | "providers" | "agents" | "spaces" | "courses" | "appearance" | "about";

/** The thread key of a space's unsent new chat. Never sent to the core. */
export const DRAFT = "new";

/** One conversation's key across spaces. */
export const chatKey = (space: string, thread: string) => `${space}/${thread}`;

type Load<T> = { data?: T; error?: string; loading: boolean };

/** A listed conversation, plus rows the UI added before the core lists them (a just-sent new chat). */
export type ThreadRow = ThreadListed & { optimistic?: true };

type Nav = {
  spaces: Load<SpaceView[]>;
  activeSpace: string | null;
  view: View;
  threads: Record<string, Load<ThreadRow[]>>;
  /** The conversation each space shows (an id, or `DRAFT` for its new chat). */
  open: Record<string, string>;
  collapsed: Record<string, boolean>;
  sidebarOpen: boolean;
  settings: SettingsSection | null;
  paletteOpen: boolean;
  viewer: { space: string; path: string } | null;
  /** Conversations (by `chatKey`) that got a reply while they weren't on screen. */
  unread: Record<string, true>;
  /** Bumped when the already-selected view tab is clicked again, so the view can go back to its front page. */
  retap: { view: View; n: number };

  loadSpaces(): Promise<void>;
  selectSpace(id: string, view?: View): void;
  setView(view: View): void;
  /** The selected view's tab was clicked again. */
  retapView(view: View): void;
  loadThreads(space: string): Promise<void>;
  /** Shows the space's new chat. Nothing is created until it is sent. */
  newChat(space: string): Promise<void>;
  openThread(space: string, id: string): Promise<void>;
  /** A new chat was sent and the core gave it `id`: it takes the draft's place. */
  adoptDraft(space: string, id: string, title: string): void;
  deleteThread(space: string, id: string): Promise<void>;
  renameThread(space: string, id: string, title: string): Promise<void>;
  pinThread(space: string, id: string, pinned: boolean): Promise<void>;
  /** Moves a conversation to the top of its space's list (a message was just sent). */
  bumpThread(space: string, id: string): void;
  /** A reply finished in a conversation: marked unread unless it is on screen. */
  replied(space: string, thread: string): void;
  markRead(space: string, thread: string): void;
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
const OPEN = "phaethon.openThreads";

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

/** Newest activity first; ties keep the core's order. */
function sortRows(rows: ThreadRow[]): ThreadRow[] {
  return [...rows].sort((a, b) => b.updated - a.updated);
}

export const useNav = create<Nav>((set, get) => {
  const setRows = (space: string, f: (rows: ThreadRow[]) => ThreadRow[]) =>
    set((s) => {
      const cur = s.threads[space];
      return { threads: { ...s.threads, [space]: { ...cur, loading: cur?.loading ?? false, data: f(cur?.data ?? []) } } };
    });

  const setOpen = (space: string, id: string) => {
    const open = { ...get().open, [space]: id };
    set({ open });
    writeJson(OPEN, open);
  };

  return {
    spaces: { loading: true },
    activeSpace: null,
    view: "chat",
    threads: {},
    open: {},
    collapsed: readJson<Record<string, boolean>>(COLLAPSED, {}),
    sidebarOpen: readJson<boolean>(SIDEBAR, true),
    settings: null,
    paletteOpen: false,
    viewer: null,
    unread: {},
    retap: { view: "chat", n: 0 },

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
      seen();
      writeJson(LAST_SPACE, id);
      void api.touchSpace(id).catch(() => {});
    },

    setView(view) {
      set({ view, settings: null });
      seen();
    },

    retapView(view) {
      set((s) => ({ retap: { view, n: s.retap.n + 1 } }));
    },

    /** A quiet refresh: what is listed stays until the answer replaces it, and rows the UI just added are kept. */
    async loadThreads(space) {
      set((s) => ({ threads: { ...s.threads, [space]: { ...s.threads[space], loading: true, error: undefined } } }));
      try {
        const list = await api.threads(space);
        set((s) => {
          const listed = new Set(list.map((t) => t.id));
          const pending = (s.threads[space]?.data ?? []).filter((t) => t.optimistic && !listed.has(t.id));
          return { threads: { ...s.threads, [space]: { data: sortRows([...pending, ...list]), loading: false } } };
        });
        // The conversation the space shows: the one remembered, else the newest, else a new chat.
        const rows = get().threads[space]?.data ?? [];
        const shown = get().open[space];
        if (shown === undefined || (shown !== DRAFT && !rows.some((t) => t.id === shown))) {
          const remembered = readJson<Record<string, string>>(OPEN, {})[space];
          const next = remembered === DRAFT ? DRAFT : rows.find((t) => t.id === remembered)?.id ?? rows[0]?.id ?? DRAFT;
          if (shown === undefined || next !== shown) setOpen(space, next);
        }
      } catch (e) {
        set((s) => ({ threads: { ...s.threads, [space]: { ...s.threads[space], loading: false, error: errorText(e) } } }));
      }
    },

    async newChat(space) {
      setOpen(space, DRAFT);
      get().selectSpace(space, "chat");
    },

    async openThread(space, id) {
      setOpen(space, id);
      get().selectSpace(space, "chat");
      get().markRead(space, id);
    },

    adoptDraft(space, id, title) {
      const now = Date.now();
      setRows(space, (rows) => sortRows([{ id, title, updated: now, messages: 1, running: true, optimistic: true }, ...rows.filter((t) => t.id !== id)]));
      if (get().open[space] === DRAFT) setOpen(space, id);
    },

    async deleteThread(space, id) {
      const before = get().threads[space]?.data ?? [];
      const at = before.findIndex((t) => t.id === id);
      setRows(space, (rows) => rows.filter((t) => t.id !== id));
      // The space shows the next conversation down (or a new chat) instead.
      if (get().open[space] === id) {
        const rest = before.filter((t) => t.id !== id);
        setOpen(space, rest[Math.min(Math.max(at, 0), rest.length - 1)]?.id ?? DRAFT);
      }
      try {
        await api.deleteThread(space, id);
      } catch (e) {
        setRows(space, (rows) => (rows.some((t) => t.id === id) ? rows : sortRows([...rows, before[at]!].filter(Boolean))));
        throw e;
      }
      const { [chatKey(space, id)]: _, ...unread } = get().unread;
      set({ unread });
    },

    async renameThread(space, id, title) {
      const t = title.trim();
      const prev = get().threads[space]?.data?.find((x) => x.id === id);
      setRows(space, (rows) => rows.map((x) => (x.id === id ? { ...x, title: t || x.title, renamed: t ? true : undefined } : x)));
      try {
        await api.renameThread(space, id, t);
      } catch (e) {
        if (prev) setRows(space, (rows) => rows.map((x) => (x.id === id ? { ...x, title: prev.title, renamed: prev.renamed } : x)));
        throw e;
      }
      // An emptied title goes back to the automatic one, which only the core knows.
      if (!t) void get().loadThreads(space);
    },

    async pinThread(space, id, pinned) {
      const prev = get().threads[space]?.data?.find((x) => x.id === id)?.pinned;
      setRows(space, (rows) => rows.map((x) => (x.id === id ? { ...x, pinned: pinned ? Date.now() : undefined } : x)));
      try {
        await api.pinThread(space, id, pinned);
      } catch (e) {
        setRows(space, (rows) => rows.map((x) => (x.id === id ? { ...x, pinned: prev } : x)));
        throw e;
      }
    },

    bumpThread(space, id) {
      setRows(space, (rows) => sortRows(rows.map((x) => (x.id === id ? { ...x, updated: Date.now() } : x))));
    },

    replied(space, thread) {
      if (onScreen(space, thread)) return;
      set({ unread: { ...get().unread, [chatKey(space, thread)]: true } });
    },

    markRead(space, thread) {
      const key = chatKey(space, thread);
      if (!get().unread[key]) return;
      const { [key]: _, ...rest } = get().unread;
      set({ unread: rest });
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
      seen();
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
  };
});

export const NO_SPACES: SpaceView[] = [];

export function useActiveSpace(): SpaceView | undefined {
  return useNav((s) => s.spaces.data?.find((x) => x.id === s.activeSpace));
}

/** The conversation `space` shows (an id or `DRAFT`). */
export function openOf(space: string): string {
  return useNav.getState().open[space] ?? DRAFT;
}

export function useOpenThread(space: string | null | undefined): string {
  return useNav((s) => (space ? (s.open[space] ?? DRAFT) : DRAFT));
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__phaethon = { ...(window.__phaethon ?? {}), nav: useNav };
}

/** Whether conversation `thread` of `space` is what the chat shows right now. */
function onScreen(space: string, thread: string): boolean {
  const s = useNav.getState();
  return s.activeSpace === space && s.view === "chat" && !s.settings && (s.open[space] ?? DRAFT) === thread;
}

/** The conversation on screen has been seen. */
function seen() {
  const s = useNav.getState();
  const space = s.activeSpace;
  if (!space || s.view !== "chat" || s.settings) return;
  s.markRead(space, s.open[space] ?? DRAFT);
}
