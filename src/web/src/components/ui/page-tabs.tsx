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
 * Slim (28 px, `h-7`), centred on the bar's middle line, the same line as the
 * wordmark and the sidebar toggle. Every tab is a `rounded-md` pill, 4 px
 * apart: the inactive ones a faint fill on the strip, deeper on hover; the
 * active one the page's colour with a hairline edge.
 *
 * Nothing moves but what was asked to: tabs are all one width, up to 200 px
 * (`w-50`, or the caller's), shrinking together only when the bar can't hold
 * them (down to 112 px, then the strip scrolls sideways, keeping the active
 * tab in view). The title bar gives the page's actions a fixed share, so
 * switching pages never resizes the tabs. The active and inactive tabs are the
 * same box (same border, padding and × slot; only colours differ), so
 * choosing a tab never shifts a label. Not a picker: choosing one of a few values is `Tabs`.
 */

/** The strip behind a tab list: the tab-strip colour and a hairline along its bottom. Put it on the bar (relative) holding the list. */
export const pageTabStripClassName =
  "bg-tab-strip after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border";

/** The tabs, centred in the strip; scrolls sideways without a scrollbar when they don't fit. */
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
      className={cn("app-no-drag scroll-quiet flex h-7 min-w-0 shrink scroll-px-2 items-center self-center overflow-x-auto overflow-y-hidden px-2", className)}
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
  /** Leave it out when closing would change nothing (a lone new chat): no ×, and a middle-click does nothing. */
  onClose?: () => void;
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
          if (e.button === 1) onClose?.();
        }}
        {...props}
        className={cn(
          // Up to 200 px each, shrinking together (all to the same width, active or not) only when the bar
          // can't hold them; the page's actions have their own fixed share, so switching pages never resizes them.
          // 4 px between neighbouring pills.
          "group/tab relative flex h-7 w-50 min-w-28 shrink cursor-default select-none px-0.5 outline-none",
          className,
        )}
      >
        <span
          data-slot="page-tab-surface"
          // The same box active or not (a 1 px border, transparent when inactive), so a label never moves.
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-clip-padding pr-1 pl-2 text-xs transition-colors group-focus-visible/tab:ring-2 group-focus-visible/tab:ring-ring group-focus-visible/tab:ring-inset",
            active ? "border-border bg-background text-foreground" : "border-transparent bg-foreground/4 text-muted-foreground group-hover/tab:bg-foreground/7 group-hover/tab:text-foreground",
          )}
        >
          <span className="flex shrink-0 [&_svg]:size-3.5">{icon}</span>
          <span className="flex min-w-0 flex-1">{label}</span>
          {/* Its slot is always there (so a label never moves); only the inactive ones hide the × until hovered. */}
          <span className="flex size-5 shrink-0">
            {onClose ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={closeLabel}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose();
                }}
                className={cn(
                  "flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-[opacity,background-color,color] hover:bg-foreground/8 hover:text-foreground",
                  active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
                )}
              >
                <Icon icon={icons.close} className="size-3" />
              </button>
            ) : null}
          </span>
        </span>
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
        "app-no-drag flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <Icon icon={icons.add} className="size-3.5" />
    </button>
  );
}
