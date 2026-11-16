import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({
  api: {
    touchSpace: vi.fn(async () => {}),
    threads: vi.fn(async () => ({ threads: [], total: 0, hasMore: false, cursor: null })),
  },
}));

const memory = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
});

const { DRAFT, canCloseTab, tabId, useNav } = await import("./store");

const SPACE = "space-a";
const nav = () => useNav.getState();
const draftId = tabId({ kind: "chat", space: SPACE, thread: DRAFT });

beforeEach(() => {
  memory.clear();
  useNav.setState({
    tabs: [],
    activeTab: null,
    closedTabs: [],
    open: {},
    activeSpace: SPACE,
    spaces: { loading: false, data: [{ id: SPACE, name: "Space", description: "", hue: 0, educationEnabled: true, lastUsed: null }] },
    // A loaded list, so a new-chat tab decides for its space.
    threads: { [SPACE]: { loading: false, data: [{ id: "t1", title: "One", updated: 1, messages: 2 }] } },
    sidebarOpen: true,
    compact: false,
    peek: false,
  });
});

describe("closing tabs", () => {
  it("closing the last tab leaves a new chat in the active space, not the conversation just closed", () => {
    void nav().openThread(SPACE, "t1", { fresh: true });
    const only = nav().tabs[0]!;
    expect(only.id).toBe(tabId({ kind: "chat", space: SPACE, thread: "t1" }));
    nav().closeTab(only.id);
    expect(nav().tabs.map((t) => t.id)).toEqual([draftId]);
    expect(nav().activeTab).toBe(draftId);
    expect(nav().open[SPACE]).toBe(DRAFT);
    expect(nav().view).toBe("chat");
    expect(nav().closedTabs[0]).toEqual({ kind: "chat", space: SPACE, thread: "t1" });
  });

  it("closing the last page or settings tab leaves a new chat", () => {
    nav().openTab({ kind: "view", space: SPACE, view: "study" });
    nav().closeTab(nav().tabs[0]!.id);
    expect(nav().tabs.map((t) => t.id)).toEqual([draftId]);
    expect(nav().settings).toBeNull();

    nav().openSettings();
    nav().closeTab(draftId);
    expect(nav().tabs.map((t) => t.id)).toEqual(["settings"]);
    nav().closeTab("settings");
    expect(nav().tabs.map((t) => t.id)).toEqual([draftId]);
    expect(nav().settings).toBeNull();
    expect(nav().activeSpace).toBe(SPACE);
  });

  it("a lone new chat can't be closed: closing it is a no-op that records nothing", () => {
    void nav().newChat(SPACE);
    expect(canCloseTab(nav().tabs, draftId)).toBe(false);
    const closed = nav().closedTabs.length;
    nav().closeTab(draftId);
    expect(nav().tabs.map((t) => t.id)).toEqual([draftId]);
    expect(nav().closedTabs.length).toBe(closed);
  });

  it("a new chat beside other tabs can be closed", () => {
    void nav().openThread(SPACE, "t1", { fresh: true });
    void nav().newChat(SPACE);
    expect(canCloseTab(nav().tabs, draftId)).toBe(true);
    nav().closeTab(draftId);
    expect(nav().tabs.map((t) => t.id)).toEqual([tabId({ kind: "chat", space: SPACE, thread: "t1" })]);
  });

  it("close others and close to the right always keep the chosen tab", () => {
    void nav().openThread(SPACE, "t1", { fresh: true });
    nav().openTab({ kind: "view", space: SPACE, view: "study" });
    nav().openTab({ kind: "view", space: SPACE, view: "grades" });
    const [first, second] = nav().tabs;
    nav().closeTabsToRight(second!.id);
    expect(nav().tabs.map((t) => t.id)).toEqual([first!.id, second!.id]);
    nav().closeOtherTabs(first!.id);
    expect(nav().tabs.map((t) => t.id)).toEqual([first!.id]);
    expect(nav().activeTab).toBe(first!.id);
    // On the last tab, close to the right closes nothing.
    nav().closeTabsToRight(first!.id);
    expect(nav().tabs.map((t) => t.id)).toEqual([first!.id]);
  });
});

describe("a compact window's floating sidebar", () => {
  const OTHER = "space-b";
  const twoSpaces = () =>
    useNav.setState({
      spaces: {
        loading: false,
        data: [
          { id: SPACE, name: "Space", description: "", hue: 0, educationEnabled: true, lastUsed: null },
          { id: OTHER, name: "Other", description: "", hue: 90, educationEnabled: false, lastUsed: null },
        ],
      },
      threads: { [SPACE]: nav().threads[SPACE]!, [OTHER]: { loading: false, data: [{ id: "o1", title: "Elsewhere", updated: 1, messages: 2 }] } },
    });

  it("the toggle brings it out and puts it away, leaving the docked preference alone", () => {
    nav().setCompact(true);
    nav().toggleSidebar();
    expect(nav().peek).toBe(true);
    nav().toggleSidebar();
    expect(nav().peek).toBe(false);
    expect(nav().sidebarOpen).toBe(true);
    expect(memory.has("phaethon.sidebar")).toBe(false);
  });

  it("choosing a conversation, a page or Settings puts it away", () => {
    nav().setCompact(true);
    for (const choose of [() => void nav().openThread(SPACE, "t1"), () => nav().setView("grades"), () => nav().openSettings()]) {
      nav().setPeek(true);
      choose();
      expect(nav().peek).toBe(false);
    }
  });

  it("switching space keeps it out, since the new space's list is what you choose from next", () => {
    twoSpaces();
    nav().setCompact(true);
    nav().openTab({ kind: "chat", space: SPACE, thread: "t1" });
    nav().setPeek(true);
    nav().selectSpace(OTHER);
    expect(nav().activeSpace).toBe(OTHER);
    expect(nav().peek).toBe(true);
  });

  it("opening the palette puts it away, and a window change shuts it", () => {
    nav().setCompact(true);
    nav().setPeek(true);
    nav().setPalette(true);
    expect(nav().peek).toBe(false);
    nav().setPeek(true);
    nav().setCompact(false);
    expect(nav().peek).toBe(false);
    expect(nav().compact).toBe(false);
  });

  it("in a wide window the toggle docks and hides as before", () => {
    nav().toggleSidebar();
    expect(nav().sidebarOpen).toBe(false);
    expect(nav().peek).toBe(false);
  });
});
