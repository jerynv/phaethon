import * as React from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { cn } from "@/lib/utils";
import { ContextMenu, ContextMenuPopup, ContextMenuTrigger } from "./context-menu";

/**
 * Open documents as a browser's tabs (docs/UI-REBUILD.md › Title bar,
 * Viewer): the title bar's open pages and the viewer's open files.
 *
 *   <div className={pageTabStripClassName}>          the grey strip with its bottom hairline
 *     <PageTabList aria-label="Open pages">
 *       <PageTab active icon={…} label={…} closeLabel="Close Study" onClose={…} menu={…} />
 *     </PageTabList>
 *     <PageTabNew label="New chat" onClick={…} />
 *   </div>
 *
 * Every tab has a shape: the inactive ones sit on the strip between thin
 * separators and fill in on hover; the active one is the page's colour with a
 * hairline edge, its lower corners flaring into the strip's hairline, so it
 * reads as part of the page below.
 *
 * Nothing moves but what was asked to: tabs are all one width, up to 200 px
 * (`w-50`, or the caller's), shrinking together only when the bar can't hold
 * them (down to 112 px, then the strip scrolls sideways, keeping the active
 * tab in view). The title bar gives the page's actions a fixed share, so
 * switching pages never resizes the tabs. The active and inactive tabs are the
 * same box (same border, padding and × slot; only colours differ), so
 * choosing a tab never shifts a label. Not a picker: choosing one of a few values is `Tabs`.
 */

/** The strip behind a tab list: the tab-strip colour and the hairline the active tab breaks. Put it on the bar (relative) holding the list. */
export const pageTabStripClassName =
  "bg-tab-strip after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border";

/** The tabs, bottom-aligned in the strip; scrolls sideways without a scrollbar when they don't fit. */
export function PageTabList({ className, children, ref, ...props }: React.ComponentProps<"div">) {
  const own = React.useRef<HTMLDivElement | null>(null);
  // When the strip narrows (a window or sidebar resize, a tab opening), the active tab stays in view.
  React.useEffect(() => {
    const el = own.current;
    if (!el) return;
    const keep = () => el.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const observer = new ResizeObserver(keep);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      role="tablist"
      {...props}
      ref={(el) => {
        own.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      className={cn("app-no-drag scroll-quiet flex h-10 min-w-0 shrink scroll-px-2 items-end self-end overflow-x-auto overflow-y-hidden px-2", className)}
    >
      {children}
    </div>
  );
}

export function PageTab({
  active,
  icon,
  label,
  closeLabel,
  onClose,
  menu,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  active: boolean;
  icon: React.ReactNode;
  /** The tab's name, already truncated by the caller (`Truncate`, `MiddleTruncate`). */
  label: React.ReactNode;
  closeLabel: string;
  onClose: () => void;
  /** The right-click menu's items. */
  menu: React.ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={<div />}
        role="tab"
        tabIndex={active ? 0 : -1}
        aria-selected={active}
        data-slot="page-tab"
        onAuxClick={(e) => {
          if (e.button === 1) onClose();
        }}
        {...props}
        className={cn(
          // Up to 200 px each, shrinking together (all to the same width, active or not) only when the bar
          // can't hold them; the page's actions have their own fixed share, so switching pages never resizes them.
          // The separator before each tab hides next to the active or hovered tab, as a browser's does.
          "group/tab relative flex h-10 w-50 min-w-28 shrink cursor-default select-none outline-none",
          "before:absolute before:top-1/2 before:left-0 before:h-4 before:w-px before:-translate-y-1/2 before:bg-border-strong before:transition-opacity",
          "first:before:opacity-0 hover:before:opacity-0 aria-selected:z-10 aria-selected:before:opacity-0 [:hover+&]:before:opacity-0 [[aria-selected=true]+&]:before:opacity-0",
          className,
        )}
      >
        <span
          data-slot="page-tab-surface"
          // The same box active or not (a 1 px border, transparent when inactive), so a label never moves.
          className={cn(
            "relative flex min-w-0 flex-1 rounded-t-lg border border-b-0 bg-clip-padding text-sm transition-colors group-focus-visible/tab:ring-2 group-focus-visible/tab:ring-ring group-focus-visible/tab:ring-inset",
            active ? "border-border bg-background text-foreground" : "border-transparent text-muted-foreground group-hover/tab:text-foreground",
          )}
        >
          {active ? null : (
            <span aria-hidden className="pointer-events-none absolute inset-x-0.5 top-1 bottom-1 rounded-md bg-foreground/5 opacity-0 transition-opacity group-hover/tab:opacity-100" />
          )}
          <span className="relative flex min-w-0 flex-1 items-center gap-2 pr-1.5 pl-3">
            <span className="flex shrink-0 [&_svg]:size-4">{icon}</span>
            <span className="flex min-w-0 flex-1">{label}</span>
            <button
              type="button"
              tabIndex={-1}
              aria-label={closeLabel}
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              // Its slot is always there; only the inactive ones hide it until hovered.
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-[opacity,background-color,color] hover:bg-foreground/8 hover:text-foreground",
                active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
              )}
            >
              <Icon icon={icons.close} className="size-3" />
            </button>
          </span>
        </span>
        {active ? (
          <>
            <span aria-hidden className="page-tab-foot" data-side="start" />
            <span aria-hidden className="page-tab-foot" data-side="end" />
          </>
        ) : null}
      </ContextMenuTrigger>
      <ContextMenuPopup>{menu}</ContextMenuPopup>
    </ContextMenu>
  );
}

/** The + after the last tab. */
export function PageTabNew({ label, className, ...props }: Omit<React.ComponentProps<"button">, "children"> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      {...props}
      className={cn(
        "app-no-drag flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <Icon icon={icons.add} className="size-4" />
    </button>
  );
}
