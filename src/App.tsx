import { useEffect, useLayoutEffect, useState } from "react";

import { SpacePane } from "@/components/chat/space-pane";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { Sidebar } from "@/components/shell/sidebar";
import { TitleBar } from "@/components/shell/title-bar";
import { useSidebar } from "@/components/shell/use-sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
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

  // The active space's hue tints the whole window, dialogs included (they
  // render in a portal outside the app root), so it is set on <html>.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--st-space-h", String(active.hue));
  }, [active.hue]);

  // Cmd+\ (Ctrl+\ elsewhere) shows and hides the sidebar.
  const { open: sidebarOpen, toggle: toggleSidebar } = sidebar;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = platform() === "mac" ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey || e.key !== "\\") return;
      e.preventDefault();
      // Hiding the sidebar while focus is in it would drop focus on the floor.
      if (sidebarOpen && document.getElementById(SIDEBAR_ID)?.contains(document.activeElement)) {
        document.getElementById("main")?.focus();
      }
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen, toggleSidebar]);

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col overflow-hidden bg-surface text-ink">
        <a
          href="#main"
          className={cn(
            "sr-only focus:not-sr-only focus:fixed focus:top-[calc(var(--st-titlebar-height)+var(--st-space)*3)] focus:left-1/2 focus:z-50 focus:-translate-x-1/2",
            "focus:rounded-md focus:bg-raised focus:px-3 focus:py-1 focus:text-base focus:font-medium focus:text-ink focus:shadow",
          )}
        >
          Skip to conversation
        </a>
        <TitleBar
          space={active}
          sidebarOpen={sidebar.open}
          onToggleSidebar={sidebar.toggle}
          sidebarId={SIDEBAR_ID}
        />
        <div className="flex min-h-0 flex-1">
          <Sidebar
            id={SIDEBAR_ID}
            open={sidebar.open}
            spaces={STUB_SPACES}
            activeId={activeId}
            onSelect={setActiveId}
            footer={inTauri() ? <SettingsDialog onChanged={() => setReloadKey((k) => k + 1)} /> : null}
          />
          <main
            id="main"
            tabIndex={-1}
            aria-labelledby="space-title"
            className={cn(
              "me-(--st-pane-inset) mb-(--st-pane-inset) flex min-w-0 flex-1 flex-col overflow-hidden",
              "rounded-lg border border-line bg-bg shadow-sm",
              !sidebar.open && "ms-(--st-pane-inset)",
            )}
          >
            <SpacePane space={active} reloadKey={reloadKey} />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
