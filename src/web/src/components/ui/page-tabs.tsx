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
 * reads as part of the page below. Tabs share the strip's width up to 240 px
 * each; squeezed, the inactive ones drop their × and go down to 72 px (the
 * active one keeps 112), then the strip scrolls sideways, always keeping the
 * active tab in view. Not a picker: choosing one of a few values is `Tabs`.
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
          // The separator before each tab hides next to the active or hovered tab, as a browser's does.
          "group/tab @container/tab relative flex h-10 w-60 shrink cursor-default select-none outline-none",
          active ? "min-w-28" : "min-w-18",
          "before:absolute before:top-1/2 before:left-0 before:h-4 before:w-px before:-translate-y-1/2 before:bg-border-strong before:transition-opacity",
          "first:before:opacity-0 hover:before:opacity-0 aria-selected:z-10 aria-selected:before:opacity-0 [:hover+&]:before:opacity-0 [[aria-selected=true]+&]:before:opacity-0",
          className,
        )}
      >
        <span
          data-slot="page-tab-surface"
          className={cn(
            "relative flex min-w-0 flex-1 items-center gap-2 pr-1.5 pl-3 text-sm transition-colors group-focus-visible/tab:ring-2 group-focus-visible/tab:ring-ring group-focus-visible/tab:ring-inset",
            active
              ? "rounded-t-lg border border-b-0 bg-background bg-clip-padding text-foreground"
              : "mx-0.5 my-1 rounded-lg text-muted-foreground group-hover/tab:bg-foreground/5 group-hover/tab:text-foreground",
          )}
        >
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
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-sm transition-[background-color,color] hover:bg-foreground/8 hover:text-foreground",
              active ? "text-muted-foreground" : "text-subtle-foreground @max-page-tab/tab:hidden",
            )}
          >
            <Icon icon={icons.close} className="size-3" />
          </button>
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
