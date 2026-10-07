import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { SpacePane } from "@/components/chat/space-pane";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { NewSpaceDialog } from "@/components/shell/new-space-dialog";
import { Sidebar } from "@/components/shell/sidebar";
import { TitleBar, useWindowFocused } from "@/components/shell/title-bar";
import { useSidebar } from "@/components/shell/use-sidebar";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Icon } from "@/icons";
import { openSettings } from "@/lib/open-settings";
import { platform } from "@/lib/platform";
import { refreshSpaces, useSpaces, type Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const SIDEBAR_ID = "spaces-sidebar";

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
  const sidebar = useSidebar();
  const focused = useWindowFocused();
  const hasSettings = inTauri();

  // The active space's hue tints the whole window, dialogs included (they
  // render in a portal outside the app root), so it is set on <html>.
  const activeHue = active?.hue;
  useLayoutEffect(() => {
    if (activeHue === undefined) document.documentElement.style.removeProperty("--ph-space-h");
    else document.documentElement.style.setProperty("--ph-space-h", String(activeHue));
  }, [activeHue]);

  // Cmd+\ (Ctrl+\ elsewhere) shows and hides the sidebar; Cmd+, (Ctrl+,) opens
  // Settings, so Settings stays reachable with the sidebar hidden.
  const { open: sidebarOpen, toggle: toggleSidebar } = sidebar;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = platform() === "mac" ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      if (e.key === "," && hasSettings) {
        e.preventDefault();
        openSettings();
        return;
      }
      if (e.key !== "\\") return;
      e.preventDefault();
      // Hiding the sidebar while focus is in it would drop focus on the floor.
      if (sidebarOpen && document.getElementById(SIDEBAR_ID)?.contains(document.activeElement)) {
        document.getElementById("main")?.focus();
      }
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen, toggleSidebar, hasSettings]);

  // In a narrow window the sidebar is opened only for a moment, to switch
  // spaces: choosing one hides it again so the conversation gets its room
  // back, and focus moves to the conversation (the chosen button is about to
  // be hidden). Escape hides it too and returns focus to the toggle.
  const { narrow: sidebarNarrow, setOpen: setSidebarOpen } = sidebar;
  const chooseSpace = useCallback(
    (id: string) => {
      setActiveId(id);
      if (!sidebarNarrow || !sidebarOpen) return;
      document.getElementById("main")?.focus();
      setSidebarOpen(false);
    },
    [sidebarNarrow, sidebarOpen, setSidebarOpen],
  );
  const dismissSidebar = useCallback(() => {
    document.querySelector<HTMLElement>(`button[aria-controls="${SIDEBAR_ID}"]`)?.focus();
    setSidebarOpen(false);
  }, [setSidebarOpen]);

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
            "sr-only focus:not-sr-only focus:fixed focus:top-[calc(var(--ph-titlebar-height)+var(--ph-space)*3)] focus:left-1/2 focus:z-50 focus:-translate-x-1/2",
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
          onToggleSidebar={sidebar.toggle}
          sidebarId={SIDEBAR_ID}
          showSettings={hasSettings && !sidebar.open}
        />
        <div className="flex min-h-0 flex-1">
          <Sidebar
            id={SIDEBAR_ID}
            open={sidebar.open}
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
            className={cn(
              "relative me-(--ph-pane-inset) mb-(--ph-pane-inset) flex min-w-0 flex-1 flex-col overflow-hidden",
              "rounded-lg border border-line bg-bg shadow-sm",
              // A short fade under the pane's top edge, so scrolled text eases out instead of being
              // sliced. Not over a focused conversation log, whose ring must show whole.
              "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-10 before:h-4 before:bg-linear-to-b before:from-bg before:to-transparent",
              "forced-colors:before:hidden has-[[role=log]:focus-visible]:before:hidden",
              !sidebar.open && "ms-(--ph-pane-inset)",
            )}
          >
            {active ? (
              <SpacePane space={active} reloadKey={reloadKey} />
            ) : spacesStatus === "loading" ? (
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
