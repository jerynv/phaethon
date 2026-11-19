import { create } from "zustand";
import { errorText } from "@/lib/core";
import { api, type SpaceView, type ThreadListed } from "./api";
import { mergeRefresh } from "./sidebar/paging";

/**
 * Where the user is: the active space, the view inside it, the overlays
 * (settings, search, file viewer), the conversation lists per space and which
 * conversation each space shows. Every conversation is addressed by its id,
 * and several can reply at once; opening one never touches the core. A space
 * can instead show its new chat (`DRAFT`), which becomes a conversation only
 * when it is first sent (features/chat/store.ts).
 */

export type View = "chat" | "files" | "study" | "grades" | "plan" | "courses";
export type SettingsSection = "general" | "notifications" | "models" | "providers" | "agents" | "spaces" | "courses" | "memory" | "people" | "mail" | "automations" | "appearance" | "about";
export type SettingsTarget = { brand?: string; mode?: "subscription" | "api" };

/**
 * What an open tab shows. Several can be open at once, like a browser's; the
 * active one decides the derived `activeSpace`, `view`, `open` and `settings`
 * fields below, which the pages read as before.
 */
/** Settings isn't a tab: it is its own place (`settings`), and leaving it goes back to the tab you were on. */
export type Tab = { kind: "chat"; space: string; thread: string } | { kind: "view"; space: string; view: Exclude<View, "chat"> };
/** An open tab. A tab opened by a plain click is a preview: the next plain click reuses it. It is kept once it has something worth keeping (a sent message, a double-click, ⌘-click). */
export type OpenTab = Tab & { id: string; kept: boolean };
export const tabId = (t: Tab): string => (t.kind === "chat" ? `chat:${t.space}/${t.thread}` : `view:${t.space}/${t.view}`);

/** The thread key of a space's unsent new chat. Never sent to the core. */
export const DRAFT = "new";

/** One conversation's key across spaces. */
export const chatKey = (space: string, thread: string) => `${space}/${thread}`;

type Load<T> = { data?: T; error?: string; loading: boolean };

/** A listed conversation, plus rows the UI added before the core lists them (a just-sent new chat). */
export type ThreadRow = ThreadListed & { optimistic?: true };

/**
 * A space's conversations as far as they are loaded: the first page (every
 * pinned one and the newest `THREAD_PAGE` others), more pages on demand
 * (`loadMoreThreads`), and single rows read again after a reply.
 */
export type ThreadList = Load<ThreadRow[]> & {
  /** How many conversations the core has in the space, loaded or not (rows the UI added itself aren't counted). */
  total?: number;
  /** Whether there are older conversations past the loaded ones. */
  hasMore?: boolean;
  /** Where the next page starts. */
  cursor?: string | null;
  loadingMore?: boolean;
};

/** Conversations loaded per page. */
export const THREAD_PAGE = 50;
/** The most a refresh reloads at once (it keeps as many as were loaded). */
const REFRESH_MAX = 500;

type Nav = {
  spaces: Load<SpaceView[]>;
  activeSpace: string | null;
  view: View;
  threads: Record<string, ThreadList>;
  /** The conversation each space shows (an id, or `DRAFT` for its new chat). */
  open: Record<string, string>;
  collapsed: Record<string, boolean>;
  /** The sidebar docked beside the page (remembered); see `compact`. */
  sidebarOpen: boolean;
  /**
   * The window is too narrow to dock the sidebar beside a page
   * (components/ui/sidebar.tsx › PAGE_MIN_WIDTH): it floats over the page
   * instead, shut until asked for (`peek`), and `sidebarOpen` waits for a wider window.
   */
  compact: boolean;
  /** The floating sidebar is out (compact windows only). Choosing a page, a conversation or Settings puts it away. */
  peek: boolean;
  settings: SettingsSection | null;
  settingsTarget: SettingsTarget | null;
  paletteOpen: boolean;
  /** What the palette starts with when it opens (the sidebar's search hands its text over). */
  paletteQuery: string;
  /** The files open in the viewer, as tabs, in order. */
  files: ViewerFile[];
  /** The file on show (one of `files`), or null when the viewer is shut. */
  viewer: ViewerFile | null;
  /** Conversations (by `chatKey`) that got a reply while they weren't on screen. */
  unread: Record<string, true>;
  /** Bumped when the already-selected view tab is clicked again, so the view can go back to its front page. */
  retap: { view: View; n: number };
  tabs: OpenTab[];
  activeTab: string | null;
  /** Tabs closed most recently, newest first, for "reopen closed tab". */
  closedTabs: Tab[];

  /** Shows `tab`: in its existing tab, else in the preview tab, else in a new one. `fresh` always opens a new tab; `keep` marks it kept (pages always are). */
  openTab(tab: Tab, opts?: { fresh?: boolean; keep?: boolean }): void;
  activateTab(id: string): void;
  closeTab(id: string): void;
  keepTab(id: string): void;
  reopenTab(): void;
  /** Closes every tab but `id` (it becomes the active one). */
  closeOtherTabs(id: string): void;
  /** Closes the tabs after `id`. */
  closeTabsToRight(id: string): void;
  /** The next (1) or previous (-1) tab, wrapping. */
  cycleTab(dir: 1 | -1): void;

  loadSpaces(): Promise<void>;
  selectSpace(id: string, view?: View): void;
  setView(view: View): void;
  /** The selected view's tab was clicked again. */
  retapView(view: View): void;
  /** Loads (or quietly reloads) a space's first page of conversations, keeping as many as were loaded. */
  loadThreads(space: string): Promise<void>;
  /** Loads the space's next page of older conversations, if there is one. */
  loadMoreThreads(space: string): Promise<void>;
  /** Reads one conversation's row again (a reply finished, or its title went back to the automatic one). */
  refreshThread(space: string, id: string): Promise<void>;
  /** Shows the space's new chat. Nothing is created until it is sent. */
  newChat(space: string): Promise<void>;
  /** Opens a conversation; one older than the loaded pages (opened from search) is read on its own so the sidebar can show it. `fresh` opens it in a new tab. */
  openThread(space: string, id: string, opts?: { fresh?: boolean }): Promise<void>;
  /** Adds a conversation the sidebar found elsewhere (a filter's search) to the space's list, if it isn't there. */
  ensureThread(space: string, row: ThreadListed): void;
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
  /** Docks or hides the sidebar; in a compact window, brings the floating one out or puts it away. */
  toggleSidebar(): void;
  setCompact(compact: boolean): void;
  setPeek(peek: boolean): void;
  openSettings(section?: SettingsSection, target?: SettingsTarget): void;
  clearSettingsTarget(): void;
  closeSettings(): void;
  setPalette(open: boolean, query?: string): void;
  /** Opens a file in the viewer: in its tab when it is open already, else in a new tab after the one on show. */
  openFile(space: string, path: string): void;
  /** Shows an open file's tab. */
  showFile(file: ViewerFile): void;
  /** Closes one file's tab (the one on show by default); the viewer shuts with the last. */
  closeFile(file?: ViewerFile): void;
  /** Closes every file but `file`. */
  closeOtherFiles(file: ViewerFile): void;
  /** Shuts the viewer and all its tabs. */
  closeAllFiles(): void;
};

const LAST_SPACE = "phaethon.lastSpace";

export type ViewerFile = { space: string; path: string };
/** The most file tabs kept open; past it the oldest one not on show closes. */
export const MAX_FILES = 12;
const sameFile = (a: ViewerFile, b: ViewerFile) => a.space === b.space && a.path === b.path;
const COLLAPSED = "phaethon.collapsed";
const SIDEBAR = "phaethon.sidebar";
const OPEN = "phaethon.openThreads";
const TABS = "phaethon.tabs";
const MAX_CLOSED = 10;

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

/** Rows by id, the first of each kept. */
function unique(rows: ThreadRow[]): ThreadRow[] {
  const seen = new Set<string>();
  return rows.filter((t) => !seen.has(t.id) && !!seen.add(t.id));
}

export const useNav = create<Nav>((set, get) => {
  const setList = (space: string, f: (cur: ThreadList) => Partial<ThreadList>) =>
    set((s) => {
      const cur = s.threads[space] ?? { loading: false };
      return { threads: { ...s.threads, [space]: { ...cur, ...f(cur) } } };
    });
  const setRows = (space: string, f: (rows: ThreadRow[]) => ThreadRow[]) => setList(space, (cur) => ({ data: f(cur.data ?? []) }));
  /** Bumped by each full reload, so a page that was asked for before it is dropped. */
  const generation: Record<string, number> = {};

  const setOpen = (space: string, id: string) => {
    const open = { ...get().open, [space]: id };
    set({ open });
    writeJson(OPEN, open);
  };

  const saveTabs = () => writeJson(TABS, { tabs: get().tabs, active: get().activeTab });
  /** The derived fields follow the active tab. */
  const apply = (tab: Tab) => {
    {
      // A new-chat tab opened before the space's list arrived doesn't choose for the space: the list's newest conversation does (loadThreads).
      const undecided = tab.kind === "chat" && tab.thread === DRAFT && !get().threads[tab.space]?.data;
      if (tab.kind === "chat" && get().open[tab.space] !== tab.thread && !undecided) setOpen(tab.space, tab.thread);
      const prev = get().activeSpace;
      set({ activeSpace: tab.space, view: tab.kind === "chat" ? "chat" : tab.view, settings: null, settingsTarget: null });
      if (prev !== tab.space) {
        writeJson(LAST_SPACE, tab.space);
        void api.touchSpace(tab.space).catch(() => {});
      }
      seen();
    }
  };
  /** Replaces the tabs and makes `id` the active one. */
  const commit = (tabs: OpenTab[], id: string) => {
    const space = get().activeSpace;
    set({ tabs, activeTab: id });
    const tab = tabs.find((t) => t.id === id);
    if (tab) apply(tab);
    settle(space);
    saveTabs();
  };
  /** A page was chosen: the floating sidebar goes away, unless only the space changed (its list is what you choose from next). */
  const settle = (spaceBefore: string | null) => {
    if (get().peek && get().activeSpace === spaceBefore) set({ peek: false });
  };
  /** A space's chat tab: the conversation it shows (an id, or its new chat). */
  const chatTab = (space: string): Tab => ({ kind: "chat", space, thread: get().open[space] ?? DRAFT });
  /** Without any tab, the active space's chat. */
  const fallbackTab = (): Tab | null => {
    const space = get().activeSpace ?? get().spaces.data?.[0]?.id;
    return space ? chatTab(space) : null;
  };
  /** After the last tab closes: a new chat in the active space (never the page just closed). */
  const openFreshChat = () => {
    const space = get().activeSpace ?? get().spaces.data?.[0]?.id;
    if (!space) return saveTabs();
    setOpen(space, DRAFT);
    get().openTab({ kind: "chat", space, thread: DRAFT });
  };

  return {
    spaces: { loading: true },
    activeSpace: null,
    view: "chat",
    threads: {},
    open: {},
    collapsed: readJson<Record<string, boolean>>(COLLAPSED, {}),
    sidebarOpen: readJson<boolean>(SIDEBAR, true),
    compact: false,
    peek: false,
    settings: null,
    settingsTarget: null,
    paletteOpen: false,
    paletteQuery: "",
    files: [],
    viewer: null,
    unread: {},
    retap: { view: "chat", n: 0 },
    tabs: [],
    activeTab: null,
    closedTabs: [],

    openTab(tab, opts = {}) {
      const id = tabId(tab);
      const tabs = get().tabs;
      const found = tabs.find((t) => t.id === id);
      if (found) {
        const next = opts.keep && !found.kept ? tabs.map((t) => (t.id === id ? { ...t, kept: true } : t)) : tabs;
        commit(next, id);
        return;
      }
      // Pages and settings are few and fixed, so they open kept; a conversation opened by a plain click is a preview.
      const open: OpenTab = { ...tab, id, kept: !!opts.keep || !!opts.fresh || tab.kind !== "chat" };
      const at = tabs.findIndex((t) => t.id === get().activeTab);
      const active = at >= 0 ? tabs[at]! : undefined;
      // A plain click on a conversation lands in the preview tab, if the active one is a preview conversation; anything else opens beside the active tab.
      if (!opts.fresh && tab.kind === "chat" && active && active.kind === "chat" && !active.kept) {
        const next = [...tabs];
        next[at] = open;
        set({ closedTabs: [strip(active), ...get().closedTabs.filter((c) => tabId(c) !== active.id)].slice(0, MAX_CLOSED) });
        commit(next, id);
      } else {
        const next = [...tabs];
        next.splice(at >= 0 ? at + 1 : tabs.length, 0, open);
        commit(next, id);
      }
    },

    activateTab(id) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return;
      const space = get().activeSpace;
      set({ activeTab: id });
      apply(tab);
      settle(space);
      saveTabs();
    },

    closeTab(id) {
      const tabs = get().tabs;
      const at = tabs.findIndex((t) => t.id === id);
      if (at < 0 || !canCloseTab(tabs, id)) return;
      const closing = tabs[at]!;
      const rest = tabs.filter((t) => t.id !== id);
      set({ closedTabs: [strip(closing), ...get().closedTabs.filter((c) => tabId(c) !== id)].slice(0, MAX_CLOSED) });
      if (get().activeTab !== id) {
        set({ tabs: rest });
        saveTabs();
        return;
      }
      const neighbour = rest[Math.min(at, rest.length - 1)];
      if (neighbour) commit(rest, neighbour.id);
      else {
        set({ tabs: [], activeTab: null });
        openFreshChat();
      }
    },

    closeOtherTabs(id) {
      const keep = get().tabs.find((t) => t.id === id);
      if (!keep) return;
      const gone = get().tabs.filter((t) => t.id !== id);
      set({ closedTabs: [...gone.reverse().map(strip), ...get().closedTabs].slice(0, MAX_CLOSED) });
      commit([keep], id);
    },

    closeTabsToRight(id) {
      const tabs = get().tabs;
      const at = tabs.findIndex((t) => t.id === id);
      if (at < 0 || at === tabs.length - 1) return;
      const gone = tabs.slice(at + 1);
      set({ closedTabs: [...gone.reverse().map(strip), ...get().closedTabs].slice(0, MAX_CLOSED) });
      const rest = tabs.slice(0, at + 1);
      const active = get().activeTab;
      commit(rest, rest.some((t) => t.id === active) ? active! : id);
    },

    keepTab(id) {
      if (!get().tabs.some((t) => t.id === id && !t.kept)) return;
      set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, kept: true } : t)) });
      saveTabs();
    },

    reopenTab() {
      const [last, ...rest] = get().closedTabs;
      if (!last) return;
      set({ closedTabs: rest });
      get().openTab(last, { fresh: true });
    },

    cycleTab(dir) {
      const tabs = get().tabs;
      if (tabs.length < 2) return;
      const at = tabs.findIndex((t) => t.id === get().activeTab);
      const next = tabs[(at + dir + tabs.length) % tabs.length];
      if (next) get().activateTab(next.id);
    },

    async loadSpaces() {
      set((s) => ({ spaces: { ...s.spaces, loading: true, error: undefined } }));
      try {
        const list = await api.spaces();
        const keep = get().activeSpace;
        const last = readJson<string | null>(LAST_SPACE, null);
        const pick = [keep, last].find((id) => id && list.some((s) => s.id === id)) ?? [...list].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))[0]?.id ?? null;
        set({ spaces: { data: list, loading: false }, activeSpace: pick });
        if (!get().tabs.length) {
          const saved = readJson<{ tabs: OpenTab[]; active: string | null }>(TABS, { tabs: [], active: null });
          // A settings tab saved by an older version is dropped: Settings is no longer a tab.
          const ok = (t: OpenTab) => (t.kind === "chat" || t.kind === "view") && list.some((s) => s.id === t.space && (t.kind === "chat" || t.view === "files" || s.educationEnabled));
          const tabs = saved.tabs.filter(ok);
          const active = tabs.find((t) => t.id === saved.active)?.id ?? tabs[0]?.id;
          if (tabs.length && active) commit(tabs, active);
          else {
            const fb = fallbackTab();
            if (fb) get().openTab(fb);
          }
        }
        for (const s of list) void get().loadThreads(s.id);
      } catch (e) {
        set({ spaces: { loading: false, error: errorText(e) } });
      }
    },

    selectSpace(id, view) {
      const space = get().spaces.data?.find((s) => s.id === id);
      // Files is in every space; the study views only where study tools are on.
      const was = get().view;
      const next = view ?? (was === "chat" || was === "files" || space?.educationEnabled ? was : "chat");
      get().openTab(next === "chat" ? chatTab(id) : { kind: "view", space: id, view: next });
    },

    setView(view) {
      const space = get().activeSpace;
      if (!space) return;
      get().openTab(view === "chat" ? chatTab(space) : { kind: "view", space, view });
    },

    retapView(view) {
      set((s) => ({ retap: { view, n: s.retap.n + 1 } }));
    },

    /** A quiet refresh: what is listed stays until the answer replaces it, and rows the UI just added are kept. */
    async loadThreads(space) {
      const gen = (generation[space] = (generation[space] ?? 0) + 1);
      const loaded = (get().threads[space]?.data ?? []).filter((t) => !t.pinned && !t.optimistic).length;
      setList(space, () => ({ loading: true, error: undefined }));
      try {
        const page = await api.threads(space, { limit: Math.min(REFRESH_MAX, Math.max(THREAD_PAGE, loaded)) });
        if (gen !== generation[space]) return;
        setList(space, (cur) => ({ ...mergeRefresh(cur, page), loading: false, total: page.total, loadingMore: false }));
        // The conversation the space shows: the one remembered, else the newest, else a new chat.
        const has = (id: string | undefined) => !!id && (get().threads[space]?.data ?? []).some((t) => t.id === id);
        const shown = get().open[space];
        if (shown === undefined || (shown !== DRAFT && !has(shown))) {
          const remembered = readJson<Record<string, string>>(OPEN, {})[space] ?? shown;
          // An older conversation than the first page holds is read on its own, so it stays open.
          if (remembered && remembered !== DRAFT && !has(remembered)) await get().refreshThread(space, remembered).catch(() => {});
          if (gen !== generation[space]) return;
          const rows = get().threads[space]?.data ?? [];
          const next = remembered === DRAFT ? DRAFT : has(remembered) ? remembered! : rows[0]?.id ?? DRAFT;
          if (shown === undefined || next !== shown) {
            setOpen(space, next);
            // A chat tab opened before the list arrived showed the new chat; it follows to the conversation the space shows.
            const from = tabId({ kind: "chat", space, thread: shown ?? DRAFT });
            const to = tabId({ kind: "chat", space, thread: next });
            if (from !== to && get().tabs.some((t) => t.id === from) && !get().tabs.some((t) => t.id === to)) {
              set({ tabs: get().tabs.map((t) => (t.id === from ? { ...t, id: to, thread: next } : t)), activeTab: get().activeTab === from ? to : get().activeTab });
              saveTabs();
            }
          }
        }
      } catch (e) {
        if (gen === generation[space]) setList(space, () => ({ loading: false, loadingMore: false, error: errorText(e) }));
      }
    },

    async loadMoreThreads(space) {
      const cur = get().threads[space];
      // While the list reloads, its answer would replace this page's rows; the reload ends with a fresh cursor to continue from.
      if (!cur?.hasMore || !cur.cursor || cur.loadingMore || cur.loading) return;
      const gen = generation[space];
      setList(space, () => ({ loadingMore: true }));
      try {
        const page = await api.threads(space, { limit: THREAD_PAGE, before: cur.cursor });
        if (gen !== generation[space]) return;
        setList(space, (c) => ({
          data: sortRows(unique([...(c.data ?? []), ...page.items])),
          hasMore: page.hasMore,
          cursor: page.nextCursor,
          loadingMore: false,
        }));
      } catch (e) {
        if (gen === generation[space]) setList(space, () => ({ loadingMore: false }));
        throw e;
      }
    },

    async refreshThread(space, id) {
      const t = await api.threadSummary(space, id);
      setList(space, (cur) => {
        const rows = cur.data ?? [];
        const had = rows.find((x) => x.id === id);
        if (!t) {
          // Not saved: a row the UI added itself stays until the list is loaded again; a listed one was deleted elsewhere.
          if (!had || had.optimistic) return {};
          return { data: rows.filter((x) => x.id !== id), total: cur.total === undefined ? undefined : Math.max(0, cur.total - 1) };
        }
        return {
          data: sortRows([t, ...rows.filter((x) => x.id !== id)]),
          // A just-sent new chat was not counted until the core saved it.
          total: cur.total !== undefined && had?.optimistic ? cur.total + 1 : cur.total,
        };
      });
    },

    async newChat(space) {
      setOpen(space, DRAFT);
      get().openTab({ kind: "chat", space, thread: DRAFT });
    },

    async openThread(space, id, opts) {
      setOpen(space, id);
      get().openTab({ kind: "chat", space, thread: id }, opts);
      get().markRead(space, id);
      const list = get().threads[space];
      if (list?.data && !list.data.some((t) => t.id === id)) await get().refreshThread(space, id).catch(() => {});
    },

    ensureThread(space, row) {
      if ((get().threads[space]?.data ?? []).some((t) => t.id === row.id)) return;
      setRows(space, (rows) => sortRows([...rows, row]));
    },

    adoptDraft(space, id, title) {
      const now = Date.now();
      setRows(space, (rows) => sortRows([{ id, title, updated: now, messages: 1, running: true, optimistic: true }, ...rows.filter((t) => t.id !== id)]));
      if (get().open[space] === DRAFT) setOpen(space, id);
      const from = tabId({ kind: "chat", space, thread: DRAFT });
      const to = tabId({ kind: "chat", space, thread: id });
      if (get().tabs.some((t) => t.id === from)) {
        set({ tabs: get().tabs.filter((t) => t.id !== to).map((t) => (t.id === from ? { ...t, id: to, thread: id, kept: true } : t)), activeTab: get().activeTab === from ? to : get().activeTab });
        saveTabs();
      }
    },

    async deleteThread(space, id) {
      const before = get().threads[space]?.data ?? [];
      const at = before.findIndex((t) => t.id === id);
      const counted = !!before[at] && !before[at]!.optimistic;
      setList(space, (cur) => ({ data: (cur.data ?? []).filter((t) => t.id !== id), total: counted && cur.total ? cur.total - 1 : cur.total }));
      // The space shows the next conversation down (or a new chat) instead.
      const gone = tabId({ kind: "chat", space, thread: id });
      const next = before.filter((t) => t.id !== id)[Math.min(Math.max(at, 0), before.length - 2)]?.id ?? DRAFT;
      if (get().open[space] === id) setOpen(space, next);
      if (get().tabs.some((t) => t.id === gone)) {
        const to = tabId({ kind: "chat", space, thread: next });
        const dup = get().tabs.some((t) => t.id === to);
        set({ tabs: get().tabs.flatMap((t) => (t.id !== gone ? [t] : dup ? [] : [{ ...t, id: to, thread: next, kept: false }])), activeTab: get().activeTab === gone ? to : get().activeTab });
        saveTabs();
      }
      try {
        await api.deleteThread(space, id);
      } catch (e) {
        setList(space, (cur) =>
          (cur.data ?? []).some((t) => t.id === id)
            ? {}
            : { data: sortRows([...(cur.data ?? []), before[at]!].filter(Boolean)), total: counted && cur.total !== undefined ? cur.total + 1 : cur.total },
        );
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
      if (!t) void get().refreshThread(space, id).catch(() => {});
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
      get().keepTab(tabId({ kind: "chat", space, thread: id }));
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
      if (get().compact) return set({ peek: !get().peek });
      const open = !get().sidebarOpen;
      set({ sidebarOpen: open });
      writeJson(SIDEBAR, open);
    },

    setCompact(compact) {
      if (compact !== get().compact) set({ compact, peek: false });
    },
    setPeek(peek) {
      if (peek !== get().peek) set({ peek });
    },

    openSettings(section = "general", target) {
      const normalized: SettingsSection = section === "providers" || section === "agents" ? "models" : section;
      const settingsTarget = target ?? (section === "agents" ? { mode: "subscription" } : null);
      set({ settings: normalized, settingsTarget, paletteOpen: false, peek: false });
    },
    clearSettingsTarget() {
      if (get().settingsTarget !== null) set({ settingsTarget: null });
    },
    closeSettings() {
      if (get().settings !== null || get().settingsTarget !== null) set({ settings: null, settingsTarget: null });
    },
    setPalette(open, query = "") {
      set({ paletteOpen: open, paletteQuery: open ? query : "", ...(open ? { peek: false } : {}) });
    },
    openFile(space, path) {
      const file = { space, path };
      const { files, viewer } = get();
      const had = files.find((f) => sameFile(f, file));
      if (had) return set({ viewer: had });
      const at = viewer ? files.findIndex((f) => sameFile(f, viewer)) + 1 : files.length;
      let next = [...files.slice(0, at), file, ...files.slice(at)];
      while (next.length > MAX_FILES) {
        const drop = next.findIndex((f) => f !== file && !(viewer && sameFile(f, viewer)));
        next = next.filter((_, i) => i !== drop);
      }
      set({ files: next, viewer: file });
    },
    showFile(file) {
      const had = get().files.find((f) => sameFile(f, file));
      if (had) set({ viewer: had });
    },
    closeFile(file) {
      const { files, viewer } = get();
      const target = file ?? viewer;
      if (!target) return;
      const at = files.findIndex((f) => sameFile(f, target));
      if (at === -1) return;
      const next = files.filter((_, i) => i !== at);
      // Closing the one on show shows its neighbour (the next, else the previous), as a browser does.
      const showing = viewer && !sameFile(viewer, target) ? viewer : (next[at] ?? next[at - 1] ?? null);
      set({ files: next, viewer: showing });
    },
    closeOtherFiles(file) {
      const had = get().files.find((f) => sameFile(f, file));
      if (had) set({ files: [had], viewer: had });
    },
    closeAllFiles() {
      set({ files: [], viewer: null });
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

/**
 * Whether closing tab `id` would change anything. Closing the last tab leaves a
 * new chat, so the one tab that can't close is a lone new chat: closing it
 * would put the same tab back.
 */
export function canCloseTab(tabs: readonly OpenTab[], id: string): boolean {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return false;
  return !(tabs.length === 1 && tab.kind === "chat" && tab.thread === DRAFT);
}

/** A tab without its open-state, for the closed list. */
function strip(t: OpenTab): Tab {
  const { id: _id, kept: _kept, ...tab } = t;
  return tab;
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
