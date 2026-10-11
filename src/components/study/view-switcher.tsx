import type { KeyboardEvent } from "react";

import { Keys, spokenKeys } from "@/components/shell/command-palette";
import { viewChord } from "@/components/shell/shortcuts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { panelId, setSpaceView, tabId, VIEWS, type SpaceView } from "./space-view";

/**
 * Chat, Study, Grades, Plan: a tab list in the space's header. Arrow keys
 * (and Home, End) move between the views and show each one; Tab leaves the
 * list from the view shown. Each view also has a shortcut (⌥⌘1…4).
 */
export function ViewSwitcher({ space, spaceName, view }: { space: string; spaceName: string; view: SpaceView }) {
  const go = (v: SpaceView) => {
    setSpaceView(space, v);
    requestAnimationFrame(() => document.getElementById(tabId(space, v))?.focus());
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = VIEWS.findIndex((v) => v.id === view);
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
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
      data-view-switcher=""
      onKeyDown={onKey}
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-sunken p-0.5 forced-colors:border forced-colors:border-[CanvasText]"
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
                  "min-h-(--ph-control-height-sm) cursor-default rounded-md px-2.5 py-0.5 text-base leading-tight font-medium select-none",
                  "transition-[color,background-color] duration-(--ph-duration-fast) ease-out",
                  selected
                    ? "bg-raised text-ink shadow-sm forced-colors:border-2 forced-colors:border-[Highlight]"
                    : "text-ink-secondary hover:bg-hover hover:text-ink",
                )}
              >
                {v.label}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" aria-label={spokenKeys(chord.keys)} className="flex items-center gap-2">
              {v.label}
              <Keys keys={chord.keys} className="[&_kbd]:border-ink-inverse/30 [&_kbd]:bg-transparent [&_kbd]:text-ink-inverse/80" />
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
