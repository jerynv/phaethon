import { useEffect, type CSSProperties } from "react";
import { readStoredSidebarWidth, SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SettingsDialog } from "@/features/settings/SettingsDialog";
import { applySpaceHue } from "@/lib/appearance";
import { announce } from "@/lib/announce";
import { moveWorkspaceFocus, startWorkspaceFocus } from "@/lib/workspaceFocus";
import { AppSidebar } from "./AppSidebar";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { CoreBanner } from "./CoreBanner";
import { MainArea } from "./MainArea";
import { useNav } from "./nav";
import { NewSpaceDialog } from "./NewSpaceDialog";
import { SearchDialog } from "./SearchDialog";
import { useShell } from "./shell-store";
import { matchShortcut } from "./shortcuts";
import { switchSpace, useCurrentSpace, useSpaces } from "./spaces";
import { newConversation, useThreadList } from "./threads";
import { TitleBar } from "./TitleBar";
import { viewLabel, visibleViews } from "./views";

/** App-wide shortcuts. Ignored while a modal dialog other than the one they open is up. */
function useShellShortcuts() {
  const { toggleSidebar } = useSidebar();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const match = matchShortcut(e);
      if (!match) return;
      if (match.id === "landmark") {
        if (moveWorkspaceFocus(match.direction)) e.preventDefault();
        return;
      }
      const modalOpen = document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]');
      const nav = useNav.getState();
      const shell = useShell.getState();
      if (modalOpen && match.id !== "settings") return;
      e.preventDefault();
      switch (match.id) {
        case "newChat":
          void newConversation(nav.spaceId);
          break;
        case "search":
          shell.setSearchOpen(true);
          break;
        case "sidebar":
          toggleSidebar();
          break;
        case "settings":
          if (nav.settings) nav.closeSettings();
          else nav.openSettings();
          break;
        case "space": {
          const target = useSpaces.getState().spaces[match.index];
          if (target) {
            switchSpace(target.id);
            announce(target.name);
          }
          break;
        }
        case "view": {
          const space = useSpaces.getState().spaces.find((s) => s.id === nav.spaceId);
          const v = visibleViews(space?.educationEnabled ?? false)[match.index];
          if (v) {
            switchSpace(nav.spaceId, { kind: v.kind });
            announce(viewLabel(v.kind));
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);
}

function ShellLayout() {
  const spaceId = useNav((s) => s.spaceId);
  const list = useThreadList(spaceId);
  useShellShortcuts();

  return (
    <>
      <a
        href="#main-content"
        className="sr-only z-[200] rounded-md bg-background px-3 py-2 font-medium text-sm shadow-md focus:not-sr-only focus:fixed focus:start-3 focus:top-3"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <AppSidebar list={list} />
      <SidebarInset className="h-svh min-h-0 overflow-hidden">
        <CoreBanner />
        <TitleBar list={list} />
        <main className="flex min-h-0 flex-1 flex-col">
          <MainArea />
        </main>
      </SidebarInset>
    </>
  );
}

/**
 * The app: sidebar, title bar and the feature views, with search, new space,
 * delete confirmation and Settings on top.
 */
export function AppShell() {
  const load = useSpaces((s) => s.load);
  const space = useCurrentSpace();

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => startWorkspaceFocus(), []);
  useEffect(() => applySpaceHue(space?.hue), [space?.hue]);

  return (
    <TooltipProvider delay={500}>
      <SidebarProvider storageKey="phaethon.sidebar-open" className="h-svh overflow-hidden" style={sidebarWidthStyle()}>
        <ShellLayout />
      </SidebarProvider>
      <SearchDialog />
      <NewSpaceDialog />
      <ConfirmDeleteDialog />
      <SettingsDialog />
    </TooltipProvider>
  );
}

function sidebarWidthStyle(): CSSProperties {
  const n = readStoredSidebarWidth("phaethon.sidebar-width");
  const width = n !== null && n >= 232 && n <= 420 ? `${n}px` : "17rem";
  return { "--sidebar-width": width } as CSSProperties;
}
