import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { goToCard, isJumpKey } from "@/components/chat/card-arrival";
import { useModelCommands } from "@/components/chat/model-picker";
import { SpacePane } from "@/components/chat/space-pane";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { announce } from "@/components/shell/announcer";
import { CommandPalette, ShortcutsSheet, type Command } from "@/components/shell/command-palette";
import { NewSpaceDialog } from "@/components/shell/new-space-dialog";
import { digitOf, isModChord, modAria, modCap, shortcutById } from "@/components/shell/shortcuts";
import { Sidebar } from "@/components/shell/sidebar";
import { TitleBar, useWindowFocused } from "@/components/shell/title-bar";
import { useSidebar } from "@/components/shell/use-sidebar";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Icon } from "@/icons";
import { useSpaceActivity } from "@/lib/activity";
import { openSettings } from "@/lib/open-settings";
import { refreshSpaces, setActiveSpaceId, useSpaces, type Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** A dialog that is open (one closing keeps focus until it is gone, and must not swallow shortcuts). */
const OPEN_DIALOG = '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]';

const SIDEBAR_ID = "spaces-sidebar";
const APP_NAME = "Phaethon";

/** The pane (one per visited space) that holds a space's conversation. */
const paneOf = (id: string) => document.querySelector<HTMLElement>(`[data-space-pane="${CSS.escape(id)}"]`);

/**
 * How many messages a space's conversation shows, once it has loaded: null
 * while it is still loading (or failed to load). Read from the pane, so it is
 * the live count (a reply that ran while you were away included).
 */
function paneMessageCount(id: string): number | null {
  const pane = paneOf(id);
  if (!pane || !pane.querySelector('[role="log"]')) return null;
  return pane.querySelectorAll('[data-role="user"], [data-role="assistant"]').length;
}

/** Focus the shown space's composer, or the conversation when it has none yet (still loading). */
function focusShownConversation(id: string) {
  const composer = paneOf(id)?.querySelector<HTMLElement>("[data-composer-input]");
  (composer ?? document.getElementById("main"))?.focus();
}

/** New conversation in the shown space: its conversations bar's button does the work (and refuses while a reply runs). */
function newConversationInShown() {
  document.querySelector<HTMLElement>("[data-space-pane][data-shown] [data-new-conversation]")?.click();
}

/** Focus is nowhere useful: on the page itself, or on something now hidden or inert. */
function focusLost(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !el || el === document.body || !!el.closest("[hidden], [inert]") || el.getClientRects().length === 0;
}

export default function App() {
  const { spaces, status: spacesStatus, error: spacesError } = useSpaces();
  const [activeId, setActiveId] = useState<string | null>(null);
  // Bumped when settings change (e.g. the backend), so the thread reloads.
  const [reloadKey, setReloadKey] = useState(0);
  // The chosen space, or the first one when nothing is chosen yet or the
  // chosen one is gone (its folder was moved or deleted outside Phaethon).
  const active: Space | undefined = spaces.find((s) => s.id === activeId) ?? spaces[0];
  // Hold on to that fallback, so a space added later that sorts first does not take over.
  const shownId = active?.id ?? null;
  useEffect(() => {
    if (shownId !== null && shownId !== activeId) setActiveId(shownId);
  }, [shownId, activeId]);
  useLayoutEffect(() => setActiveSpaceId(shownId), [shownId]);
  const sidebar = useSidebar();
  const focused = useWindowFocused();
  const hasSettings = inTauri();
  const modelCommands = useModelCommands(active);

  // Every space visited stays mounted (hidden while another is shown), so a
  // reply keeps running, a card keeps waiting and a draft keeps its words.
  // A space that leaves the vault leaves this list too.
  const [visited, setVisited] = useState<readonly string[]>([]);
  if (shownId && !visited.includes(shownId)) setVisited([...visited, shownId]);
  const mounted = spaces.filter((s) => visited.includes(s.id));

  // The active space's hue tints the whole window, dialogs included (they
  // render in a portal outside the app root), so it is set on <html>.
  const activeHue = active?.hue;
  useLayoutEffect(() => {
    if (activeHue === undefined) document.documentElement.style.removeProperty("--ph-space-h");
    else document.documentElement.style.setProperty("--ph-space-h", String(activeHue));
  }, [activeHue]);

  // The window's title names the space ("School — Phaethon"): the Window menu,
  // Mission Control, the taskbar and screen readers' window lists show it.
  const activeName = active?.name;
  useEffect(() => {
    const title = activeName ? `${activeName} — ${APP_NAME}` : APP_NAME;
    document.title = title;
    if (inTauri()) {
      getCurrentWindow()
        .setTitle(title)
        .catch((e: unknown) => console.warn("set window title:", e));
    }
  }, [activeName]);

  // A switch says where you are and how much is there: "School, 12 messages".
  // Said once the conversation has loaded (at most a few seconds' wait).
  const lastShown = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastShown.current;
    lastShown.current = shownId;
    if (!shownId || !activeName || prev === null || prev === shownId) return;
    let frame = 0;
    const started = performance.now();
    const tick = () => {
      const n = paneMessageCount(shownId);
      if (n === null && performance.now() - started < 4000) {
        frame = requestAnimationFrame(tick);
        return;
      }
      announce(n === null ? activeName : n === 0 ? `${activeName}, no messages yet` : `${activeName}, ${n} ${n === 1 ? "message" : "messages"}`);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // The name is read when the switch happens; a rename is not a switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownId]);

  // A space you are not looking at that starts needing you is announced
  // (politely), and so is a reply there ending; the sidebar shows both.
  const activity = useSpaceActivity();
  const lastActivity = useRef(activity);
  useEffect(() => {
    const before = lastActivity.current;
    lastActivity.current = activity;
    for (const [id, now] of Object.entries(activity)) {
      if (id === shownId) continue;
      const was = before[id];
      const name = spaces.find((s) => s.id === id)?.name;
      if (!name) continue;
      if (now.needsYou && !was?.needsYou) announce(`${name} needs your answer.`);
      else if (was?.running && !now.running && !now.needsYou) announce(`The reply in ${name} has ended.`);
    }
  }, [activity, shownId, spaces]);

  // Choosing a space. In a narrow window the sidebar lies over the
  // conversation only for a moment, to switch: choosing hides it again and
  // focus moves to the conversation. Chosen from the keyboard (Cmd+1…9, the
  // palette), focus moves to the new space's composer when it had been in the
  // space now hidden.
  const { narrow: sidebarNarrow, open: sidebarOpen, setOpen: setSidebarOpen, toggle: toggleSidebar } = sidebar;
  const overlay = sidebarNarrow && sidebarOpen;
  const chooseSpace = useCallback(
    (id: string) => {
      setActiveId(id);
      if (!sidebarNarrow || !sidebarOpen) return;
      setSidebarOpen(false);
      // The conversation is inert until the sidebar has closed: focus it on the next frame.
      requestAnimationFrame(() => document.getElementById("main")?.focus());
    },
    [sidebarNarrow, sidebarOpen, setSidebarOpen],
  );
  const goToSpace = useCallback(
    (id: string) => {
      setActiveId(id);
      if (sidebarNarrow && sidebarOpen) setSidebarOpen(false);
      requestAnimationFrame(() => {
        if (focusLost() || document.getElementById(SIDEBAR_ID)?.contains(document.activeElement)) focusShownConversation(id);
      });
    },
    [sidebarNarrow, sidebarOpen, setSidebarOpen],
  );
  const dismissSidebar = useCallback(() => {
    document.querySelector<HTMLElement>(`button[aria-controls="${SIDEBAR_ID}"]`)?.focus();
    setSidebarOpen(false);
  }, [setSidebarOpen]);
  const toggleSidebarKeepingFocus = useCallback(() => {
    // Hiding the sidebar while focus is in it would drop focus on the floor.
    if (sidebarOpen && document.getElementById(SIDEBAR_ID)?.contains(document.activeElement)) {
      document.getElementById("main")?.focus();
    }
    toggleSidebar();
  }, [sidebarOpen, toggleSidebar]);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Shortcuts, all chords with the command key (Ctrl elsewhere), so they work
  // while typing and never take a key a text field needs:
  //   Cmd+\ sidebar · Cmd+, Settings · Cmd+1…9 spaces · Cmd+K palette · Cmd+/ this list.
  // While Settings (or another dialog) has focus only Cmd+\ and Cmd+, apply,
  // and Cmd+K / Cmd+/ close their own window again.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModChord(e) || e.defaultPrevented) return;
      const inDialog = !!(document.activeElement as HTMLElement | null)?.closest(OPEN_DIALOG);
      if (e.key === "," && hasSettings) {
        e.preventDefault();
        openSettings();
        return;
      }
      if (e.key === "\\") {
        e.preventDefault();
        toggleSidebarKeepingFocus();
        return;
      }
      if (e.key.toLowerCase() === "k" || e.code === "KeyK") {
        if (inDialog && !paletteOpen) return;
        e.preventDefault();
        setSheetOpen(false);
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.key === "/" || e.code === "Slash") {
        if (inDialog && !sheetOpen) return;
        e.preventDefault();
        setPaletteOpen(false);
        setSheetOpen((o) => !o);
        return;
      }
      const n = digitOf(e);
      if (n !== null) {
        if (inDialog) return;
        // Taken even with no space there, so the webview never acts on it.
        e.preventDefault();
        const target = spaces[n - 1];
        if (target) goToSpace(target.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebarKeepingFocus, hasSettings, spaces, goToSpace, paletteOpen, sheetOpen]);

  // Option+Return (Alt+Enter) from anywhere in the window goes to the card waiting for an answer in the
  // space on screen. Taken first (capture), so a focused button is never pressed by the Return; with
  // nothing waiting it says so rather than doing nothing. Inside a dialog it is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isJumpKey(e) || e.defaultPrevented) return;
      const at = document.activeElement as HTMLElement | null;
      if (at?.closest(OPEN_DIALOG)) return;
      const card = document.querySelector<HTMLElement>("[data-space-pane][data-shown] [data-waiting-card]");
      if (card?.contains(at)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (card) goToCard(card);
      else announce("Nothing in this space is waiting for your answer.");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Cmd+N (Ctrl+N) belongs to the conversations bar, but every visited space
  // has one mounted, each listening on the window: the first one mounted would
  // answer, whichever space is shown. Taken here first (capture) and sent to
  // the shown space's own New conversation button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isModChord(e) || (e.key.toLowerCase() !== "n" && e.code !== "KeyN")) return;
      if ((document.activeElement as HTMLElement | null)?.closest(OPEN_DIALOG)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      newConversationInShown();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // New space: a fresh form (new key) each time it opens. After creating, the
  // new space is chosen and its sidebar entry takes focus (the conversation
  // when the sidebar is hidden); after cancelling, focus goes back where it was.
  const [newSpace, setNewSpace] = useState({ key: 0, open: false });
  const newSpaceOpener = useRef<HTMLElement | null>(null);
  const createdId = useRef<string | null>(null);
  const openNewSpace = useCallback(() => {
    newSpaceOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    createdId.current = null;
    setNewSpace((n) => ({ key: n.key + 1, open: true }));
  }, []);
  const focusAfterNewSpace = useCallback((created: boolean) => {
    requestAnimationFrame(() => {
      const main = document.getElementById("main");
      if (created && createdId.current) {
        const entry = document.querySelector<HTMLElement>(`#${SIDEBAR_ID}:not([hidden]) [data-space-id="${createdId.current}"]`);
        (entry ?? main)?.focus();
        return;
      }
      const back = newSpaceOpener.current;
      (back?.isConnected && back.offsetParent !== null ? back : main)?.focus();
    });
  }, []);

  // The palette's commands: every space, then actions, then each Settings section.
  const commands = useMemo<Command[]>(() => {
    const mod = modCap();
    const aria = modAria();
    const list: Command[] = spaces.map((s, i) => ({
      id: `space:${s.id}`,
      group: "Spaces",
      label: s.name,
      hint: s.description || undefined,
      keywords: "space go switch",
      hue: s.hue,
      current: s.id === shownId,
      shortcut: i < 9 ? { keys: [mod, String(i + 1)], aria: `${aria}+${i + 1}` } : undefined,
      run: () => goToSpace(s.id),
    }));
    if (active) {
      list.push({
        id: "new-conversation",
        group: "Actions",
        label: "New conversation",
        hint: `in ${active.name}`,
        keywords: "chat thread start fresh",
        icon: "plus",
        shortcut: shortcutById("new"),
        run: newConversationInShown,
      });
      list.push(...modelCommands);
    }
    list.push(
      {
        id: "new-space",
        group: "Actions",
        label: "New space…",
        keywords: "create add",
        icon: "space",
        run: openNewSpace,
      },
      {
        id: "toggle-sidebar",
        group: "Actions",
        label: sidebarOpen ? "Hide sidebar" : "Show sidebar",
        keywords: "spaces panel",
        icon: "sidebar",
        shortcut: shortcutById("sidebar"),
        run: toggleSidebar,
      },
      {
        id: "shortcuts",
        group: "Actions",
        label: "Keyboard shortcuts",
        keywords: "keys help cheat sheet",
        icon: "info",
        shortcut: shortcutById("shortcuts"),
        run: () => setSheetOpen(true),
      },
    );
    if (hasSettings) {
      list.push({
        id: "settings",
        group: "Settings",
        label: "Settings",
        keywords: "preferences options",
        icon: "settings",
        shortcut: shortcutById("settings"),
        run: () => openSettings(),
      });
      const sections: [string, string, string][] = [
        ["agent", "Agent", "api key model backend claude"],
        ["appearance", "Appearance", "theme dark light colour color text size"],
        ["accessibility", "Accessibility", "reading font dyslexic contrast motion"],
        ["spaces", "Spaces", "grants access rename colour"],
        ["about", "About", "version vault folder"],
      ];
      for (const [id, label, keywords] of sections) {
        list.push({
          id: `settings:${id}`,
          group: "Settings",
          label: `Settings: ${label}`,
          keywords: `preferences ${keywords}`,
          icon: "settings",
          run: () => openSettings(id),
        });
      }
    }
    return list;
  }, [spaces, shownId, active, goToSpace, openNewSpace, sidebarOpen, toggleSidebar, hasSettings, modelCommands]);

  return (
    <TooltipProvider>
      {/* data-inactive: the window lost focus, so the chrome and the sidebar selection dim, as native windows do. */}
      <div
        data-inactive={focused ? undefined : ""}
        className="group/app flex h-dvh flex-col overflow-hidden bg-surface text-ink"
      >
        <a
          href="#main"
          className={cn(
            "sr-only focus:not-sr-only focus:fixed focus:top-[calc(var(--ph-titlebar-room)+var(--ph-space)*3)] focus:left-1/2 focus:z-50 focus:-translate-x-1/2",
            "focus:rounded-md focus:bg-raised focus:px-3 focus:py-1 focus:text-base focus:font-medium focus:text-ink focus:shadow",
          )}
        >
          Skip to conversation
        </a>
        <TitleBar
          space={active}
          emptyTitle={spacesStatus === "loading" ? "" : spacesStatus === "error" ? "Spaces unavailable" : "No spaces yet"}
          inactive={!focused}
          sidebarOpen={sidebar.open}
          sidebarDocked={sidebar.docked}
          labels={sidebar.labels}
          onToggleSidebar={sidebar.toggle}
          sidebarId={SIDEBAR_ID}
          showSettings={hasSettings && !sidebar.docked}
        />
        {/* Positioned: in a narrow window the sidebar lies over the conversation, inside this row. */}
        <div className="relative flex min-h-0 flex-1">
          <Sidebar
            id={SIDEBAR_ID}
            open={sidebar.open}
            overlay={sidebarNarrow}
            spaces={spaces}
            loading={spacesStatus !== "ready"}
            activeId={active?.id ?? ""}
            onNewSpace={openNewSpace}
            onSelect={chooseSpace}
            onDismiss={sidebarNarrow ? dismissSidebar : undefined}
            footer={hasSettings ? <SettingsDialog onChanged={() => setReloadKey((k) => k + 1)} /> : null}
          />
          <main
            id="main"
            tabIndex={-1}
            aria-labelledby="space-title"
            // Behind the overlaid sidebar the conversation is out of reach until it closes.
            inert={overlay}
            className={cn(
              "relative me-(--ph-pane-inset) mb-(--ph-pane-inset) flex min-w-0 flex-1 flex-col overflow-hidden",
              "rounded-lg border border-line bg-bg shadow-sm",
              // A short fade under the pane's top edge, so scrolled text eases out instead of being
              // sliced. Not over a focused conversation log, whose ring must show whole.
              "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-10 before:h-4 before:bg-linear-to-b before:from-bg before:to-transparent",
              "forced-colors:before:hidden has-[[role=log]:focus-visible]:before:hidden",
              !sidebar.docked && "ms-(--ph-pane-inset)",
            )}
          >
            {mounted.map((s) => {
              const shown = s.id === active?.id;
              return (
                // A space not shown is inert (out of reach for focus, pointer and screen readers) and
                // invisible, but keeps its size and layout: `hidden` (display: none) would lose its
                // scroll position and make the conversation jump to the end when shown again.
                <div
                  key={s.id}
                  data-space-pane={s.id}
                  data-shown={shown ? "" : undefined}
                  inert={!shown}
                  className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !shown && "invisible absolute inset-0")}
                >
                  <SpacePane space={s} reloadKey={reloadKey} />
                </div>
              );
            })}
            {active ? null : spacesStatus === "loading" ? (
              <p role="status" className="m-auto flex items-center gap-2 text-md text-ink-secondary">
                <Icon name="spinner" className="animate-spin" />
                Loading your spaces…
              </p>
            ) : spacesStatus === "error" ? (
              <SpacesError error={spacesError ?? ""} />
            ) : (
              <NoSpaces onNewSpace={openNewSpace} />
            )}
          </main>
        </div>
        <NewSpaceDialog
          key={newSpace.key}
          open={newSpace.open}
          onOpenChange={(open) => setNewSpace((n) => ({ ...n, open }))}
          existing={spaces}
          onCreated={(space) => {
            createdId.current = space.id;
            chooseSpace(space.id);
          }}
          onCloseFocus={focusAfterNewSpace}
        />
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
        <ShortcutsSheet open={sheetOpen} onOpenChange={setSheetOpen} />
      </div>
    </TooltipProvider>
  );
}

/** A vault with no spaces: what a space is, and the one thing to do. */
function NoSpaces({ onNewSpace }: { onNewSpace: () => void }) {
  return (
    <div data-no-spaces="" className="m-auto flex max-w-(--ph-measure) flex-col items-center gap-3 px-6 text-center">
      <span className="grid size-[calc(var(--ph-icon-size-lg)*2)] place-items-center rounded-full bg-accent-soft text-accent-soft-ink">
        <Icon name="space" className="size-(--ph-icon-size-lg)" />
      </span>
      <h2 className="text-lg font-semibold text-ink">Make your first space</h2>
      <p className="text-base text-ink-secondary">
        A space is a separate place for one part of your life, like school or work. Each has its own files and its own conversation.
      </p>
      <Button type="button" onClick={onNewSpace}>
        <Icon name="plus" />
        New space
      </Button>
    </div>
  );
}

function SpacesError({ error }: { error: string }) {
  return (
    <div className="mx-auto w-full max-w-(--ph-thread-width) px-6 pt-8">
      <div className="flex items-start gap-3 rounded-lg border border-transparent bg-danger-soft px-4 py-3 text-base text-ink">
        <Icon name="error" className="mt-0.5 text-danger-ink" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div role="alert" className="flex flex-col gap-0.5">
            <p className="font-semibold text-danger-ink">Your spaces couldn’t be loaded</p>
            <p className="wrap-anywhere">{error}</p>
          </div>
          <div>
            <Button type="button" onClick={() => void refreshSpaces()}>
              <Icon name="retry" />
              Try again
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
