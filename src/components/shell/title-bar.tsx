import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "@/icons";
import { modKeyLabel, platform } from "@/lib/platform";
import type { Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

import { SpaceMark } from "./space-mark";
import { WindowControls } from "./window-controls";

type Props = {
  space: Space;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Id of the element the sidebar toggle shows and hides. */
  sidebarId: string;
  /** Room for future per-space actions, at the trailing end of the bar. */
  actions?: ReactNode;
};

/** True while the app window has focus; the chrome dims when it does not, as native windows do. */
function useWindowFocused() {
  const [focused, setFocused] = useState(() => (typeof document === "undefined" ? true : document.hasFocus()));
  useEffect(() => {
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  return focused;
}

/**
 * The window's title bar, drawn by steward. On macOS the system window buttons
 * sit inside it (tauri.macos.conf.json); on Windows and Linux it carries our
 * own controls at the trailing edge. The whole bar drags the window and a
 * double-click maximizes it; buttons inside it stay clickable (Tauri skips
 * interactive elements in a "deep" drag region).
 */
export function TitleBar({ space, sidebarOpen, onToggleSidebar, sidebarId, actions }: Props) {
  const focused = useWindowFocused();
  const ownControls = platform() !== "mac" && inTauri();
  const toggleLabel = sidebarOpen ? "Hide sidebar" : "Show sidebar";
  const shortcut = `${modKeyLabel()}\\`;

  return (
    <header
      data-tauri-drag-region="deep"
      data-shell-chrome=""
      data-inactive={focused ? undefined : ""}
      className="group/titlebar flex h-(--st-titlebar-height) shrink-0 items-center bg-surface"
    >
      {/* Leading cluster: as wide as the sidebar when it is open, so the title lines up with the pane below. */}
      <div
        className={cn(
          "flex h-full shrink-0 items-center ps-(--st-titlebar-inset-start) pe-2",
          sidebarOpen && "w-(--st-sidebar-width)",
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={toggleLabel}
              aria-controls={sidebarId}
              aria-keyshortcuts={platform() === "mac" ? "Meta+Backslash" : "Control+Backslash"}
              onClick={onToggleSidebar}
              className="group-data-[inactive]/titlebar:text-ink-tertiary"
            >
              <Icon name="sidebar" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {toggleLabel}
            <kbd className="ms-2 font-sans text-ink-inverse/70">{shortcut}</kbd>
          </TooltipContent>
        </Tooltip>
      </div>

      <div className={cn("flex h-full min-w-0 flex-1 items-center gap-2", sidebarOpen ? "ps-(--st-pane-inset)" : "ps-1")}>
        <SpaceMark hue={space.hue} />
        <h1
          id="space-title"
          className="truncate text-md leading-tight font-semibold text-ink group-data-[inactive]/titlebar:text-ink-secondary"
        >
          {space.name}
        </h1>
      </div>

      {actions && <div className="flex h-full shrink-0 items-center gap-1 pe-2">{actions}</div>}

      {ownControls ? <WindowControls /> : <div aria-hidden="true" className="w-2 shrink-0" />}
    </header>
  );
}
