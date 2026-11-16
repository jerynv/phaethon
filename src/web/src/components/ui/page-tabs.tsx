import { LayoutGroup, motion, useReducedMotion } from "motion/react";
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
 * Each tab's label sits on the bar's line (`--titlebar-line`), the same line
 * as the wordmark and the sidebar toggle; the 28 px row ends 2 px above the
 * bar's bottom edge, and tabs stand 2 px apart. The active tab is the page itself reaching
 * up into the strip: its surface (the page's colour, a hairline on top and
 * sides, curving out into the page at its base) runs from the label down to
 * the bar's bottom edge and covers the strip's hairline there, so tab and page
 * are one piece. That surface is a single underlay that slides to whichever
 * tab is chosen. Inactive tabs are just their label, with a faint pill on hover.
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

/** Which strip a tab belongs to, so each strip's underlay slides only between its own tabs. */
const StripContext = React.createContext<string>("page-tabs");

/** The tabs, along the strip's full height (labels on its middle line); scrolls sideways without a scrollbar when they don't fit. */
export function PageTabList({ className, children, ref, ...props }: React.ComponentProps<"div">) {
  const own = React.useRef<HTMLDivElement | null>(null);
  const strip = React.useId();
  // When the strip narrows (a window or sidebar resize, a tab opening), the active tab stays in view.
  // While it overflows, the edge with more tabs past it fades out, so a cut-off tab reads as "more this way".
  React.useEffect(() => {
    const el = own.current;
    if (!el) return;
    const edges = () => {
      const more = el.scrollWidth - el.clientWidth;
      el.toggleAttribute("data-more-start", more > 1 && el.scrollLeft > 1);
      el.toggleAttribute("data-more-end", more > 1 && el.scrollLeft < more - 1);
    };
    const keep = () => {
      el.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
      edges();
    };
    const observer = new ResizeObserver(keep);
    observer.observe(el);
    const mutations = new MutationObserver(edges);
    mutations.observe(el, { childList: true });
    el.addEventListener("scroll", edges, { passive: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
      el.removeEventListener("scroll", edges);
    };
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
      className={cn(
        // Above the strip's hairline (z-1), so the active tab's surface covers it where tab meets page.
        "app-no-drag scroll-quiet relative z-1 flex h-full min-w-0 shrink scroll-px-3 items-stretch gap-0.5 self-stretch overflow-x-auto overflow-y-hidden px-3",
        "[--fade:2rem] data-more-end:mask-r-from-[calc(100%-var(--fade))] data-more-start:mask-l-from-[calc(100%-var(--fade))]",
        className,
      )}
    >
      <StripContext value={strip}>
        <LayoutGroup id={strip}>{children}</LayoutGroup>
      </StripContext>
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
          // The 28 px label row is centred on the bar's line (--titlebar-line), the wordmark's, and ends 2 px above its bottom edge.
          "group/tab relative flex h-full w-50 min-w-28 shrink cursor-default select-none flex-col pt-[calc(var(--titlebar-line)-0.875rem)] outline-none",
          className,
        )}
      >
        {active ? <TabUnderlay /> : null}
        <span
          data-slot="page-tab-surface"
          // The same box active or not, so a label never moves; only the colours differ.
          className={cn(
            "relative z-1 flex h-7 min-w-0 items-center gap-1.5 rounded-md pr-1 pl-2.5 text-xs transition-colors group-focus-visible/tab:ring-2 group-focus-visible/tab:ring-ring group-focus-visible/tab:ring-inset",
            active ? "text-foreground" : "text-muted-foreground group-hover/tab:bg-foreground/5 group-hover/tab:text-foreground",
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

/**
 * The active tab's surface: the page's colour from the label row down through
 * the strip's bottom hairline, a hairline on its top and sides, and a small
 * curve out into the page at each base corner. One per strip, shared by
 * layout id, so it slides from tab to tab.
 */
function TabUnderlay() {
  const strip = React.useContext(StripContext);
  const reduce = useReducedMotion();
  return (
    <motion.span
      aria-hidden
      layoutId={`${strip}-underlay`}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 42, mass: 0.8 }}
      data-slot="page-tab-underlay"
      className={cn(
        "pointer-events-none absolute inset-x-0 top-[calc(var(--titlebar-line)-0.875rem)] -bottom-px rounded-t-lg border border-b-0 border-border bg-background [--curve:0.5rem]",
        // The base curves: a quarter circle cut from a page-coloured square on each side, its edge a hairline.
        "before:absolute before:-left-(--curve) before:bottom-0 before:size-(--curve) before:bg-[radial-gradient(circle_at_0_0,transparent_calc(var(--curve)-1px),var(--border)_calc(var(--curve)-0.5px),var(--border)_var(--curve),var(--background)_calc(var(--curve)+0.5px))]",
        "after:absolute after:-right-(--curve) after:bottom-0 after:size-(--curve) after:bg-[radial-gradient(circle_at_100%_0,transparent_calc(var(--curve)-1px),var(--border)_calc(var(--curve)-0.5px),var(--border)_var(--curve),var(--background)_calc(var(--curve)+0.5px))]",
      )}
    />
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
