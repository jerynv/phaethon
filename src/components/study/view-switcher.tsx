import type { KeyboardEvent } from "react";

import { Keys, spokenKeys } from "@/components/shell/command-palette";
import { viewChord } from "@/components/shell/shortcuts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { panelId, setSpaceView, tabId, VIEWS, type SpaceView } from "./space-view";

/**
 * Chat, Study, Grades, Plan: a tab list, under the current space in the
 * sidebar (vertical) or, while the sidebar is hidden, in the space's compact
 * header. Arrow keys (Up and Down when vertical, Left and Right otherwise;
 * Home, End) move between the views and show each one; Tab leaves the list
 * from the view shown. Each view also has a shortcut (⌥⌘1…4).
 */
export function ViewSwitcher({
  space,
  spaceName,
  view,
  orientation = "horizontal",
}: {
  space: string;
  spaceName: string;
  view: SpaceView;
  orientation?: "horizontal" | "vertical";
}) {
  const vertical = orientation === "vertical";
  const go = (v: SpaceView) => {
    setSpaceView(space, v);
    requestAnimationFrame(() => document.getElementById(tabId(space, v))?.focus());
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = VIEWS.findIndex((v) => v.id === view);
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const step = vertical ? { ArrowDown: 1, ArrowUp: -1 }[e.key] : { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
    let to: number | null = null;
    if (step) to = (at + step + VIEWS.length) % VIEWS.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = VIEWS.length - 1;
    if (to === null) return;
    e.preventDefault();
    go(VIEWS[to].id);
  };
  return (
    <div
      role="tablist"
      aria-label={`${spaceName} views`}
      aria-orientation={orientation}
      data-view-switcher=""
      onKeyDown={onKey}
      className={cn("flex shrink-0 gap-0.5", vertical ? "flex-col items-stretch" : "items-center")}
    >
      {VIEWS.map((v) => {
        const selected = v.id === view;
        const chord = viewChord(v.digit);
        return (
          <Tooltip key={v.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="tab"
                id={tabId(space, v.id)}
                aria-selected={selected}
                aria-controls={panelId(space, v.id)}
                aria-keyshortcuts={chord.aria}
                tabIndex={selected ? 0 : -1}
                data-view-tab={v.id}
                onClick={() => setSpaceView(space, v.id)}
                className={cn(
                  // Quiet text tabs, selected as a sidebar row is: no track, no raised chip.
                  "min-h-(--ph-control-height-sm) cursor-default rounded-md border border-transparent px-2 py-0.5 leading-tight select-none",
                  vertical ? "w-full text-start text-sm" : "text-base font-medium",
                  "transition-[color,background-color] duration-(--ph-duration-fast) ease-out",
                  selected
                    ? "bg-selected text-ink forced-colors:border-[Highlight]"
                    : "text-ink-secondary hover:bg-hover hover:text-ink",
                )}
              >
                {v.label}
              </button>
            </TooltipTrigger>
            <TooltipContent side={vertical ? "right" : "bottom"} aria-label={spokenKeys(chord.keys)} className="flex items-center gap-2">
              {v.label}
              <Keys keys={chord.keys} className="[&_kbd]:border-ink-inverse/30 [&_kbd]:bg-transparent [&_kbd]:text-ink-inverse/80" />
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
