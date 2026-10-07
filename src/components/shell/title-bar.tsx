import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "@/icons";
import { openSettings } from "@/lib/open-settings";
import { modKeyLabel, platform } from "@/lib/platform";
import type { Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

import { GrantsChip } from "./grants-chip";
import { SpaceMark } from "./space-mark";
import { WindowControls } from "./window-controls";

type Props = {
  /** The current space; none while the list loads or when the vault has no spaces. */
  space: Space | undefined;
  /** The heading when there is no space ("No spaces yet"). */
  emptyTitle?: string;
  /** The window does not have focus: the chrome dims, as native windows do. */
  inactive: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Id of the element the sidebar toggle shows and hides. */
  sidebarId: string;
  /** Show a Settings button (the sidebar, which holds the usual entry, is hidden). */
  showSettings: boolean;
  /** Room for future per-space actions, at the trailing end of the bar. */
  actions?: ReactNode;
};

/** True while the app window has focus. */
export function useWindowFocused() {
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

/** An icon button in the bar with a tooltip that names it and shows its shortcut. */
function BarButton({
  label,
  shortcut,
  keyshortcuts,
  icon,
  onClick,
  ...rest
}: {
  label: string;
  shortcut: string;
  keyshortcuts: string;
  icon: "sidebar" | "settings";
  onClick: () => void;
  "aria-controls"?: string;
  "data-testid"?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-keyshortcuts={keyshortcuts}
          onClick={onClick}
          className="group-data-[inactive]/titlebar:text-ink-tertiary"
          {...rest}
        >
          <Icon name={icon} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        <kbd className="ms-2 font-sans text-ink-inverse/70">{shortcut}</kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The window's title bar, drawn by Phaethon. On macOS the system window buttons
 * sit inside it (tauri.macos.conf.json); on Windows and Linux it carries our
 * own controls at the trailing edge. The whole bar drags the window and a
 * double-click maximizes it; buttons inside it stay clickable (Tauri skips
 * interactive elements in a "deep" drag region).
 *
 * The space's name never gives up room: the grants chip beside it shrinks (and
 * in a narrow window collapses to a count) before the title truncates.
 */
export function TitleBar({ space, emptyTitle = "", inactive, sidebarOpen, onToggleSidebar, sidebarId, showSettings, actions }: Props) {
  const ownControls = platform() !== "mac" && inTauri();
  const mac = platform() === "mac";
  const toggleLabel = sidebarOpen ? "Hide sidebar" : "Show sidebar";
  const [status, setStatus] = useState("");
  const announce = useCallback((m: string) => {
    // Clear first so the same message twice is announced twice.
    setStatus("");
    requestAnimationFrame(() => setStatus(m));
  }, []);

  return (
    <header
      data-tauri-drag-region="deep"
      data-shell-chrome=""
      data-inactive={inactive ? "" : undefined}
      className="group/titlebar flex h-(--ph-titlebar-height) shrink-0 items-center bg-surface"
    >
      {/* Leading cluster: as wide as the sidebar when it is open, so the title lines up with the pane below. */}
      <div
        className={cn(
          "flex h-full shrink-0 items-center gap-1 ps-(--ph-titlebar-inset-start) pe-2",
          sidebarOpen && "w-(--ph-sidebar-width)",
        )}
      >
        <BarButton
          label={toggleLabel}
          shortcut={`${modKeyLabel()}\\`}
          keyshortcuts={mac ? "Meta+Backslash" : "Control+Backslash"}
          icon="sidebar"
          aria-controls={sidebarId}
          onClick={onToggleSidebar}
        />
        {/* With the sidebar hidden, its Settings entry is too; this one stands in for it. */}
        {showSettings && (
          <BarButton
            label="Settings"
            shortcut={mac ? "⌘," : "Ctrl+,"}
            keyshortcuts={mac ? "Meta+Comma" : "Control+Comma"}
            icon="settings"
            data-testid="titlebar-settings"
            onClick={() => openSettings()}
          />
        )}
      </div>

      <div className={cn("flex h-full min-w-0 flex-1 items-center gap-2", sidebarOpen ? "ps-(--ph-pane-inset)" : "ps-1")}>
        {space && <SpaceMark hue={space.hue} />}
        <h1
          id="space-title"
          className="max-w-full shrink-0 truncate text-md leading-tight font-semibold text-ink group-data-[inactive]/titlebar:text-ink-secondary"
        >
          {space ? space.name : emptyTitle}
        </h1>
        {space && <GrantsChip space={space} announce={announce} />}
      </div>
      {/* Outside the chip, which goes away when its last grant is revoked. */}
      <p role="status" className="sr-only">
        {status}
      </p>

      {actions && <div className="flex h-full shrink-0 items-center gap-1 pe-2">{actions}</div>}

      {ownControls ? <WindowControls /> : <div aria-hidden="true" className="w-2 shrink-0" />}
    </header>
  );
}
