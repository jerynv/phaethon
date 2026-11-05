import type { KeyboardEvent } from "react";

import { Keys, spokenKeys } from "@/components/shell/command-palette";
import { viewChord } from "@/components/shell/shortcuts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon, type IconName } from "@/icons";
import { cn } from "@/lib/utils";

import { panelId, setSpaceView, tabId, visibleViews, type SpaceView } from "./space-view";

const viewIcons: Record<SpaceView, IconName> = { chat: "chat", study: "book", grades: "success", plan: "file-text" };

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
  currentConversationShown = false,
}: {
  space: string;
  spaceName: string;
  view: SpaceView;
  orientation?: "horizontal" | "vertical";
  currentConversationShown?: boolean;
}) {
  const views = visibleViews(space);
  const vertical = orientation === "vertical";
  const go = (v: SpaceView) => {
    setSpaceView(space, v);
    requestAnimationFrame(() => document.getElementById(tabId(space, v))?.focus());
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = views.findIndex((v) => v.id === view);
    const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
    const step = vertical ? { ArrowDown: 1, ArrowUp: -1 }[e.key] : { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[e.key];
    let to: number | null = null;
    if (step) to = (at + step + views.length) % views.length;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = views.length - 1;
    if (to === null) return;
    e.preventDefault();
    go(views[to].id);
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
      {views.map((v) => {
        const selected = v.id === view;
        const filled = selected && !(vertical && v.id === "chat" && currentConversationShown);
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
                  // One selected destination: the current thread stands in for its Chat parent.
                  "min-h-(--ph-control-height) cursor-default rounded-md border border-transparent px-2 py-1 leading-tight select-none",
                  vertical ? "flex w-full items-center gap-2.5 text-start text-sm font-normal" : "text-sm font-normal",
                  "transition-[color,background-color] duration-(--ph-duration-fast) ease-out",
                  filled
                    ? "bg-selected text-ink forced-colors:border-[Highlight]"
                    : selected ? "text-ink hover:bg-hover" : "text-ink-secondary hover:bg-hover hover:text-ink",
                )}
              >
                {vertical && <Icon name={viewIcons[v.id]} className="size-(--ph-icon-size-sm)" />}
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
