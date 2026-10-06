import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
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
};

/**
 * Space switcher. Every item is a native button (Tab reaches each one);
 * ArrowUp/ArrowDown/Home/End also move focus within the list. The current
 * space is marked with aria-current and shown in its own hue.
 */
export function Sidebar({ id, spaces, activeId, onSelect, open, footer }: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLUListElement>) {
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

  return (
    <nav
      id={id}
      aria-labelledby="spaces-heading"
      hidden={!open}
      data-shell-chrome=""
      className="flex w-(--ph-sidebar-width) shrink-0 flex-col bg-surface text-ink"
    >
      <h2 id="spaces-heading" className="px-4 pt-2 pb-1.5 text-xs font-medium text-ink-secondary">
        Spaces
      </h2>
      <ScrollArea className="min-h-0 flex-1">
        <ul ref={listRef} onKeyDown={onKeyDown} className="flex flex-col gap-0.5 px-2 pb-3">
          {spaces.map((space) => {
            const active = space.id === activeId;
            return (
              <li key={space.id}>
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  aria-describedby={`space-desc-${space.id}`}
                  onClick={() => onSelect(space.id)}
                  data-space-hue=""
                  style={spaceHueStyle(space.hue)}
                  className={cn(
                    // Two rows: the dot centres on the name row, the description sits under the name.
                    "grid w-full min-w-0 grid-cols-[var(--ph-space-mark-size)_minmax(0,1fr)] items-center gap-x-2.5 rounded-md px-2 py-1.5 text-start",
                    "transition-colors duration-(--ph-duration-fast)",
                    active ? "bg-space-tint" : "hover:bg-hover active:bg-selected",
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
      </ScrollArea>
      {footer && <div className="px-2 pt-1 pb-2">{footer}</div>}
    </nav>
  );
}
