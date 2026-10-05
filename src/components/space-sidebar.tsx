import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { Space } from "@/lib/spaces";

type Props = {
  spaces: readonly Space[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Shown below the list (e.g. the Settings button). */
  footer?: ReactNode;
};

/**
 * Space switcher. Every item is a native button (Tab reaches each one);
 * ArrowUp/ArrowDown/Home/End also move focus within the list.
 */
export function SpaceSidebar({ spaces, activeId, onSelect, footer }: Props) {
  const listRef = useRef<HTMLUListElement>(null);

  function onKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
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
      aria-labelledby="spaces-heading"
      className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
    >
      <h2 id="spaces-heading" className="px-4 pt-4 pb-2 text-sm font-semibold">
        Spaces
      </h2>
      <ScrollArea className="min-h-0 flex-1">
        <ul ref={listRef} onKeyDown={onKeyDown} className="flex flex-col gap-1 px-2 pb-4">
          {spaces.map((space) => {
            const active = space.id === activeId;
            return (
              <li key={space.id}>
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  aria-describedby={`space-desc-${space.id}`}
                  onClick={() => onSelect(space.id)}
                  className={cn(
                    "flex w-full flex-col items-start rounded-md px-3 py-2 text-left text-sm",
                    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    active && "bg-sidebar-accent font-semibold text-sidebar-accent-foreground",
                  )}
                >
                  <span>{space.name}</span>
                  <span
                    id={`space-desc-${space.id}`}
                    className="text-xs font-normal text-muted-foreground"
                  >
                    {space.description}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
      {footer && <div className="border-t border-sidebar-border p-2">{footer}</div>}
    </nav>
  );
}
