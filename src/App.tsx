import { useCallback, useEffect, useLayoutEffect, useState } from "react";

import { SpacePane } from "@/components/chat/space-pane";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { Sidebar } from "@/components/shell/sidebar";
import { TitleBar, useWindowFocused } from "@/components/shell/title-bar";
import { useSidebar } from "@/components/shell/use-sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { openSettings } from "@/lib/open-settings";
import { platform } from "@/lib/platform";
import { STUB_SPACES } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

const SIDEBAR_ID = "spaces-sidebar";

export default function App() {
  const [activeId, setActiveId] = useState(STUB_SPACES[0].id);
  // Bumped when settings change (e.g. the backend), so the thread reloads.
  const [reloadKey, setReloadKey] = useState(0);
  const active = STUB_SPACES.find((s) => s.id === activeId) ?? STUB_SPACES[0];
  const sidebar = useSidebar();
  const focused = useWindowFocused();
  const hasSettings = inTauri();

  // The active space's hue tints the whole window, dialogs included (they
  // render in a portal outside the app root), so it is set on <html>.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--ph-space-h", String(active.hue));
  }, [active.hue]);

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
            spaces={STUB_SPACES}
            activeId={activeId}
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
            <SpacePane space={active} reloadKey={reloadKey} />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
