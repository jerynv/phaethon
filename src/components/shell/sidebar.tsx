import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Icon } from "@/icons";
import type { Space } from "@/lib/spaces";
import { cn } from "@/lib/utils";

import { spaceHueStyle, SpaceMark } from "./space-mark";

type Props = {
  id: string;
  spaces: readonly Space[];
  activeId: string;
  onSelect: (id: string) => void;
  /** False hides the whole sidebar (and takes it out of the tab order). */
  open: boolean;
  /** Pinned below the list (the Settings entry). */
  footer?: ReactNode;
  /** Given while the sidebar is a temporary one (narrow window): Escape inside it calls this. */
  onDismiss?: () => void;
  /** Opens the New space dialog. */
  onNewSpace: () => void;
  /** The list is still loading: no empty-state line yet. */
  loading?: boolean;
};

/**
 * Space switcher. Every item is a native button (Tab reaches each one);
 * ArrowUp/ArrowDown/Home/End also move focus within the list and on to "New
 * space" at its end. The current space is marked with aria-current and shown
 * in its own hue. A vault with no spaces says so above "New space".
 */
export function Sidebar({ id, spaces, activeId, onSelect, open, footer, onDismiss, onNewSpace, loading }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) return;
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (i + 1) % buttons.length;
    else if (e.key === "ArrowUp") next = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    if (next !== null) {
      e.preventDefault();
      buttons[next]?.focus();
    }
  }

  function onNavKeyDown(e: KeyboardEvent<HTMLElement>) {
    // Only keys pressed in the sidebar itself: React also bubbles events from
    // portals (the Settings dialog), whose Escape belongs to the dialog.
    if (e.key !== "Escape" || !onDismiss || !e.currentTarget.contains(e.target as Node)) return;
    e.preventDefault();
    onDismiss();
  }

  return (
    <nav
      id={id}
      onKeyDown={onNavKeyDown}
      aria-labelledby="spaces-heading"
      hidden={!open}
      data-shell-chrome=""
      className="flex w-(--ph-sidebar-width) shrink-0 flex-col bg-surface text-ink"
    >
      <h2 id="spaces-heading" className="px-4 pt-2 text-xs font-medium text-ink-secondary">
        Spaces
      </h2>
      <ScrollArea className="min-h-0 flex-1">
        {/* p-2 on every side: the scroll viewport clips, and the focus ring sits outside each item. */}
        <div ref={listRef} onKeyDown={onKeyDown} className="flex flex-col gap-0.5 p-2">
          {!loading && spaces.length === 0 && <p className="px-2 py-1.5 text-sm text-ink-secondary">No spaces yet.</p>}
          <ul className="flex flex-col gap-0.5 empty:hidden">
            {spaces.map((space) => {
              const active = space.id === activeId;
              return (
                <li key={space.id}>
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    aria-describedby={space.description ? `space-desc-${space.id}` : undefined}
                    onClick={() => onSelect(space.id)}
                    data-space-hue=""
                    data-space-id={space.id}
                    style={spaceHueStyle(space.hue)}
                    className={cn(
                      // Two rows: the dot centres on the name row, the description sits under the name.
                      "grid w-full min-w-0 grid-cols-[var(--ph-space-mark-size)_minmax(0,1fr)] items-center gap-x-2.5 rounded-md px-2 py-1.5 text-start",
                      "transition-colors duration-(--ph-duration-fast)",
                      // In a background window the selection greys, as macOS does.
                      active ? "bg-space-tint group-data-[inactive]/app:bg-selected" : "hover:bg-hover active:bg-selected",
                    )}
                  >
                    <SpaceMark hue={space.hue} />
                    <span className={cn("truncate text-base text-ink", active ? "font-semibold" : "font-medium")}>
                      {space.name}
                    </span>
                    <span id={`space-desc-${space.id}`} className="col-start-2 truncate text-xs text-ink-secondary">
                      {space.description}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {/* Same columns as a space, so "New space" lines up with the names above it. */}
          <button
            type="button"
            data-new-space=""
            onClick={onNewSpace}
            className={cn(
              "grid min-h-(--ph-control-height) w-full min-w-0 grid-cols-[var(--ph-space-mark-size)_minmax(0,1fr)] items-center gap-x-2.5 rounded-md px-2 py-1 text-start",
              "text-base text-ink-secondary transition-colors duration-(--ph-duration-fast) hover:bg-hover hover:text-ink active:bg-selected",
            )}
          >
            <Icon name="plus" className="size-(--ph-icon-size-sm) justify-self-center" />
            <span className="truncate">New space</span>
          </button>
        </div>
      </ScrollArea>
      {footer && <div className="px-2 pt-1 pb-2">{footer}</div>}
    </nav>
  );
}
