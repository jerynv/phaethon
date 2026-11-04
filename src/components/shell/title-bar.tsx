import { useEffect, useState, type ReactNode } from "react";

import { useSpaceView, viewLabel } from "@/components/study/space-view";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "@/icons";
import { useConversations } from "@/lib/conversation-nav";
import { openSettings } from "@/lib/open-settings";
import { platform } from "@/lib/platform";
import type { Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

import { ShellAnnouncer } from "./announcer";
import { Keys, spokenKeys } from "./command-palette";
import { GrantsChip } from "./grants-chip";
import { modAria, modCap } from "./shortcuts";
import { SpaceMark } from "./space-mark";
import { WindowControls } from "./window-controls";

type Props = {
  /** The current space; none while the list loads or when the vault has no spaces. */
  space: Space | undefined;
  /** The heading when there is no space ("No spaces yet"). */
  emptyTitle?: string;
  /** The window does not have focus: the chrome dims, as native windows do. */
  inactive: boolean;
  /** The sidebar is showing (docked or over the conversation). */
  sidebarOpen: boolean;
  /** The sidebar sits beside the conversation (so the bar's leading cluster lines up with it). */
  sidebarDocked: boolean;
  /** The Spaces and Settings buttons show their words, not only an icon (when the sidebar is not docked). */
  labels: boolean;
  onToggleSidebar: () => void;
  /** Id of the element the sidebar toggle shows and hides. */
  sidebarId: string;
  /** Show a Settings button (the sidebar, which holds the usual entry, is not docked). */
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

/**
 * A button in the bar: an icon, plus its word when `text` is given (then the
 * word is its name, as Voice Control expects). A tooltip shows the name and
 * shortcut for the pointer; as the button's description it gives only the
 * shortcut, so the name is not said twice.
 */
function BarButton({
  label,
  text,
  keys,
  keyshortcuts,
  icon,
  onClick,
  ...rest
}: {
  label: string;
  text?: string;
  keys: string[];
  keyshortcuts: string;
  icon: "sidebar" | "settings";
  onClick: () => void;
  "aria-controls"?: string;
  "aria-expanded"?: boolean;
  "data-testid"?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size={text ? "default" : "icon"}
          aria-label={text ? undefined : label}
          aria-keyshortcuts={keyshortcuts}
          onClick={onClick}
          // Inactive, its words dim only as far as text may (secondary); the icon further (tertiary is for icons and large text).
          className="min-w-0 group-data-[inactive]/titlebar:text-ink-secondary group-data-[inactive]/titlebar:[&_svg]:text-ink-tertiary"
          {...rest}
        >
          <Icon name={icon} />
          {text && <span className="truncate">{text}</span>}
        </Button>
      </TooltipTrigger>
      {/* While it shows, Radix describes the button by the tooltip: only the shortcut, in words, so the name is not said twice. */}
      <TooltipContent side="bottom" aria-label={spokenKeys(keys)} className="flex items-center gap-2">
        {label}
        <Keys keys={keys} className="[&_kbd]:border-ink-inverse/30 [&_kbd]:bg-transparent [&_kbd]:text-ink-inverse/80" />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Where you are, after the space's name: the open conversation's title in Chat
 * (when it was last used is in the sidebar's row), the view's name elsewhere. One
 * trail in one place, so the space's header below holds only its controls.
 * The shape follows T3 Code's WorkspaceBreadcrumb (apps/web/src/components/
 * WorkspaceBreadcrumb.tsx, MIT): an ordered list, separators unspoken, the
 * last item aria-current.
 */
function Trail({ space }: { space: Space }) {
  const view = useSpaceView(space.id);
  const current = useConversations(space.id)?.threads.find((t) => t.current);
  if (view !== "chat") {
    return (
      <li aria-current="page" className="min-w-0 truncate text-base leading-tight font-medium text-ink" data-breadcrumb-view={view}>
        {viewLabel(view)}
      </li>
    );
  }
  if (!current || current.messages === 0) {
    return (
      <li aria-current="page" className="min-w-0 truncate text-base leading-tight font-medium text-ink">
        New conversation
      </li>
    );
  }
  return (
    <li aria-current="page" data-conversation-current="" className="min-w-0 truncate text-base leading-tight font-medium text-ink" title={current.title}>
      {current.title}
    </li>
  );
}

/**
 * The window's title bar, drawn by Phaethon. On macOS the system window buttons
 * sit inside it (tauri.macos.conf.json); on Windows and Linux it carries our
 * own controls at the trailing edge. The whole bar drags the window and a
 * double-click maximizes it; buttons inside it stay clickable (Tauri skips
 * interactive elements in a "deep" drag region).
 *
 * With the sidebar not docked, its toggle reads "Spaces" and a "Settings"
 * button stands in for the sidebar's own (both icons only when the window
 * has no room, never at a large text size).
 *
 * The space's name never gives up room: the grant chips beside it ("Also
 * reads", "Read by") shrink (and in a narrow window collapse to a count)
 * before the title truncates.
 */
export function TitleBar({
  space,
  emptyTitle = "",
  inactive,
  sidebarOpen,
  sidebarDocked,
  labels,
  onToggleSidebar,
  sidebarId,
  showSettings,
  actions,
}: Props) {
  const ownControls = platform() !== "mac" && inTauri();
  const mod = modCap();
  const aria = modAria();
  const words = labels && !sidebarDocked;

  return (
    <header
      data-tauri-drag-region="deep"
      data-shell-chrome=""
      data-inactive={inactive ? "" : undefined}
      className="group/titlebar flex h-(--ph-titlebar-room) shrink-0 items-center bg-bg"
    >
      {/* Leading cluster. With the sidebar docked it is the top of the sidebar's column (same width, surface
          and divider), so the sidebar runs the window’s full height and the title starts where the pane does. */}
      <div
        className={cn(
          "flex h-full min-w-0 shrink-0 items-center gap-2 ps-(--ph-titlebar-inset-start) pe-2",
          sidebarDocked && "w-(--ph-sidebar-width) border-e border-line bg-surface forced-colors:border-[CanvasText]",
        )}
      >
        <BarButton
          label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          text={words ? "Spaces" : undefined}
          keys={[mod, "\\"]}
          keyshortcuts={`${aria}+Backslash`}
          icon="sidebar"
          aria-controls={sidebarId}
          aria-expanded={sidebarOpen}
          onClick={onToggleSidebar}
        />
        {sidebarDocked && !words && <span className="min-w-0 truncate text-base font-medium text-ink">Phaethon</span>}
        {/* With the sidebar not docked, its Settings entry is out of reach; this one stands in for it. */}
        {showSettings && (
          <BarButton
            label="Settings"
            text={words ? "Settings" : undefined}
            keys={[mod, ","]}
            keyshortcuts={`${aria}+Comma`}
            icon="settings"
            data-testid="titlebar-settings"
            onClick={() => openSettings()}
          />
        )}
      </div>

      <div className={cn("flex h-full min-w-0 flex-1 items-center gap-2", sidebarDocked ? "ps-4" : "ps-1")}>
        {space && <SpaceMark hue={space.hue} />}
        <nav aria-label="Where you are" className="flex min-w-0 shrink items-center">
          <ol className="m-0 flex min-w-0 list-none items-baseline gap-2 p-0">
            <li className="flex min-w-0 max-w-40 shrink items-center">
              <h1
                id="space-title"
                className="max-w-full truncate text-base leading-tight font-normal text-ink-secondary"
              >
                {space ? space.name : emptyTitle}
              </h1>
            </li>
            {space && (
              <>
                <li aria-hidden="true" className="shrink-0 text-base leading-tight text-ink-tertiary">
                  /
                </li>
                <Trail space={space} />
              </>
            )}
          </ol>
        </nav>
        {space && <GrantsChip space={space} direction="out" />}
        {space && <GrantsChip space={space} direction="in" />}
      </div>
      {/* Outside the chips, which go away when their last grant is revoked. */}
      <ShellAnnouncer />

      {actions && <div className="flex h-full shrink-0 items-center gap-1 pe-2">{actions}</div>}

      {ownControls ? <WindowControls /> : <div aria-hidden="true" className="w-2 shrink-0" />}
    </header>
  );
}
