// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT, after the shadcn/ui sidebar (https://ui.shadcn.com), MIT. See THIRD_PARTY_NOTICES.md.
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/utils";
import { RowGlideContext } from "./row-highlight";
import { ScrollArea } from "./scroll-area";
import { Skeleton } from "./skeleton";

/**
 * The app's left panel as composable parts: a provider that owns open state
 * and width, an offcanvas panel with a rail you drag to resize (double-click
 * resets), and groups of 28 px menu rows with hover actions and badges.
 * Open state lives in the caller (the nav store) so shortcuts and the header
 * can toggle it; width is kept on this computer.
 *
 * A window too narrow to hold the panel and a `PAGE_MIN_WIDTH` page side by
 * side is compact: the panel floats over the page instead of pushing it (a
 * popup layer with its shadow, a faint scrim behind), and Esc or a click
 * outside puts it away.
 */

const WIDTH_KEY = "phaethon.sidebarWidth";
export const SIDEBAR_WIDTH_DEFAULT = 248;
export const SIDEBAR_WIDTH_MIN = 216;
export const SIDEBAR_WIDTH_MAX = 420;
/** The narrowest page the docked panel leaves beside it; a window that can't hold both is compact. */
export const PAGE_MIN_WIDTH = 520;

/** The widest the panel may be dragged in this window, so dragging never pushes the page under `PAGE_MIN_WIDTH`. */
const widthCap = () => (typeof window === "undefined" ? SIDEBAR_WIDTH_MAX : Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, window.innerWidth - PAGE_MIN_WIDTH)));
const clampWidth = (w: number, max = SIDEBAR_WIDTH_MAX) => Math.round(Math.max(SIDEBAR_WIDTH_MIN, Math.min(max, w)));

function readWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(v) && v > 0 ? clampWidth(v) : SIDEBAR_WIDTH_DEFAULT;
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

/** Settings and the shell both read `--sidebar-width`, so it lives on the root element. */
function applyWidth(w: number) {
  document.documentElement.style.setProperty("--sidebar-width", `${w}px`);
}

type SidebarContextValue = {
  open: boolean;
  /** Floating over the page (a compact window) rather than docked beside it. */
  floating: boolean;
  toggle: () => void;
  width: number;
  setWidth: (w: number, persist?: boolean) => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const ctx = React.use(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used inside SidebarProvider");
  return ctx;
}

export function SidebarProvider({
  open,
  onToggle,
  floating = false,
  onCompactChange,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  open: boolean;
  onToggle: () => void;
  /** Float over the page instead of docking (the caller's answer to `onCompactChange`). */
  floating?: boolean;
  /** Called with whether the window is too narrow to dock the panel beside a `PAGE_MIN_WIDTH` page, now and on every resize that changes it. */
  onCompactChange?: (compact: boolean) => void;
}) {
  const [width, setWidthState] = React.useState(readWidth);
  React.useLayoutEffect(() => applyWidth(width), [width]);
  const report = React.useEffectEvent(() => onCompactChange?.(window.innerWidth < width + PAGE_MIN_WIDTH));
  React.useLayoutEffect(() => {
    report();
    window.addEventListener("resize", report);
    return () => window.removeEventListener("resize", report);
  }, [width]);
  const setWidth = React.useCallback((w: number, persist = true) => {
    const next = clampWidth(w, persist ? SIDEBAR_WIDTH_MAX : widthCap());
    setWidthState(next);
    if (!persist) return;
    try {
      if (next === SIDEBAR_WIDTH_DEFAULT) localStorage.removeItem(WIDTH_KEY);
      else localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      // Private window: the width lasts for the session.
    }
  }, []);
  const value = React.useMemo(() => ({ open, floating, toggle: onToggle, width, setWidth }), [open, floating, onToggle, width, setWidth]);
  return (
    <SidebarContext value={value}>
      <div
        className={cn("group/sidebar-wrapper flex h-full w-full", className)}
        data-slot="sidebar-wrapper"
        data-sidebar-state={open ? "expanded" : "collapsed"}
        data-sidebar-floating={floating || undefined}
        {...props}
      >
        {children}
      </div>
    </SidebarContext>
  );
}

/**
 * Offcanvas: collapsing slides it out and makes it inert, so focus and clicks
 * never land in it. Floating, it takes no room: it slides out over the page,
 * takes focus (its selected row, else itself), and Esc or a click on the
 * scrim puts it away and hands focus back to whatever opened it.
 */
export function Sidebar({ className, children, ...props }: React.ComponentProps<"div">) {
  const { open, floating, toggle } = useSidebar();
  const container = React.useRef<HTMLDivElement>(null);
  const opener = React.useRef<HTMLElement | null>(null);
  const out = floating && open;
  React.useEffect(() => {
    if (!out) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = container.current;
    (el?.querySelector<HTMLElement>("[data-active=true]") ?? el)?.focus({ preventScroll: true });
    return () => {
      // Back to the toggle (or whatever opened it), unless focus already moved on to what was chosen.
      if (el?.contains(document.activeElement) || document.activeElement === document.body) opener.current?.focus({ preventScroll: true });
    };
  }, [out]);
  return (
    <div
      className={cn("group peer relative h-full shrink-0 text-sidebar-foreground", floating && "z-(--z-sheet)")}
      data-slot="sidebar"
      data-state={open ? "expanded" : "collapsed"}
      data-collapsible={open ? "" : "offcanvas"}
      data-floating={floating || undefined}
    >
      <div
        data-slot="sidebar-gap"
        className="h-full w-(--sidebar-width) transition-[width] duration-200 ease-drawer group-data-[collapsible=offcanvas]:w-0 group-data-floating:w-0 group-data-floating:transition-none group-data-[resizing=true]/sidebar-wrapper:transition-none"
      />
      {out ? <div aria-hidden data-slot="sidebar-scrim" className="fixed inset-x-0 bottom-0 top-(--titlebar-height) bg-foreground/6" onPointerDown={toggle} /> : null}
      <div
        ref={container}
        data-slot="sidebar-container"
        inert={!open}
        tabIndex={out ? -1 : undefined}
        onKeyDown={(e) => {
          if (!out || e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          e.stopPropagation();
          toggle();
        }}
        className={cn(
          "absolute inset-y-0 left-0 flex w-(--sidebar-width) border-r outline-none transition-[translate] duration-200 ease-drawer group-data-[collapsible=offcanvas]:-translate-x-full group-data-[resizing=true]/sidebar-wrapper:transition-none",
          "group-data-floating:max-w-(--viewport-max-width) group-data-floating:shadow-popup group-data-[collapsible=offcanvas]:group-data-floating:shadow-none",
          className,
        )}
        {...props}
      >
        <div data-slot="sidebar-inner" className="flex h-full w-full min-w-0 flex-col bg-sidebar">
          {children}
        </div>
      </div>
    </div>
  );
}

/** The panel's right edge: drag to resize, double-click for the default width. */
export function SidebarRail({ className }: { className?: string }) {
  const { open, floating, width, setWidth } = useSidebar();
  const drag = React.useRef<{ x: number; w: number; id: number; wrapper: HTMLElement | null } | null>(null);
  const end = (e: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    d.wrapper?.removeAttribute("data-resizing");
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    if (e.currentTarget.hasPointerCapture(d.id)) e.currentTarget.releasePointerCapture(d.id);
    if (commit) setWidth(Math.min(widthCap(), d.w + e.clientX - d.x));
    else setWidth(d.w, false);
  };
  if (!open || floating) return null;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH_MIN}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      data-slot="sidebar-rail"
      title="Drag to resize"
      className={cn(
        "app-no-drag absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors hover:after:bg-ring/60 data-[dragging=true]:after:bg-ring",
        className,
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const wrapper = e.currentTarget.closest<HTMLElement>("[data-slot=sidebar-wrapper]");
        wrapper?.setAttribute("data-resizing", "true");
        drag.current = { x: e.clientX, w: width, id: e.pointerId, wrapper };
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) setWidth(d.w + e.clientX - d.x, false);
      }}
      onPointerUp={(e) => end(e, true)}
      onPointerCancel={(e) => end(e, false)}
      onDoubleClick={() => setWidth(SIDEBAR_WIDTH_DEFAULT)}
    />
  );
}

export function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex shrink-0 flex-col gap-1", className)} data-slot="sidebar-header" {...props} />;
}

/** One row under a hairline, `--footer-height` tall like every bottom bar beside the sidebar. */
export function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex h-(--footer-height) shrink-0 flex-col justify-center border-t px-2", className)} data-slot="sidebar-footer" {...props} />;
}

/** The scrolling middle. `scrollRef` is the scrolling element (for a windowed list); `fade="end"` fades only the bottom edge, under a sticky top row. */
export function SidebarContent({ className, scrollRef, fade = true, ...props }: React.ComponentProps<"div"> & { scrollRef?: React.Ref<HTMLDivElement>; fade?: boolean | "end" }) {
  return (
    <ScrollArea hideScrollbars scrollFade={fade} scrollFadePadding={false} viewportRef={scrollRef} className="h-auto min-h-0 flex-1">
      <div className={cn("flex w-full min-w-0 flex-col [overflow-anchor:none]", className)} data-slot="sidebar-content" {...props} />
    </ScrollArea>
  );
}

export function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("relative flex w-full min-w-0 flex-col px-2 py-1", className)} data-slot="sidebar-group" {...props} />;
}

export function SidebarGroupLabel({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps({ className: cn("group/label flex h-7 shrink-0 items-center gap-1 px-2 type-label", className), "data-slot": "sidebar-group-label" }, props),
  });
}

/** A small icon button at the end of a group label, shown on hover of the label. */
export function SidebarGroupAction({ className, render, ...props }: useRender.ComponentProps<"button">) {
  const defaults = {
    type: "button" as const,
    className: cn(
      "ml-auto inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/label:opacity-100 [&_svg]:size-3.5",
      className,
    ),
    "data-slot": "sidebar-group-action",
  };
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(defaults, props),
  });
}

export function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul className={cn("flex w-full min-w-0 flex-col gap-px", className)} data-slot="sidebar-menu" {...props} />;
}

export function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li className={cn("group/menu-item relative", className)} data-slot="sidebar-menu-item" {...props} />;
}

export const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md text-left outline-hidden transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-60 data-[active=true]:bg-row-selected data-[active=true]:text-foreground data-glide:data-[active=true]:bg-transparent data-glide:data-[active=true]:hover:bg-transparent [&>svg]:shrink-0 [&>svg]:text-icon-muted",
  {
    variants: {
      size: {
        default: "h-7 px-2 text-sm",
        sm: "h-6 px-2 text-xs",
      },
      tone: {
        default: "text-sidebar-foreground/85",
        muted: "text-muted-foreground",
      },
    },
    defaultVariants: { size: "default", tone: "default" },
  },
);

/**
 * A 28 px row. `isActive` marks the selected one; inside a `RowHighlightGroup`
 * (or with `glide`) the list draws that fill as one highlight that glides
 * between rows (components/ui/row-highlight.tsx) instead of the row's own.
 */
export function SidebarMenuButton({
  isActive = false,
  glide,
  size,
  tone,
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> & { isActive?: boolean; glide?: boolean } & VariantProps<typeof sidebarMenuButtonVariants>) {
  const inGroup = React.use(RowGlideContext);
  const defaults = {
    type: "button" as const,
    className: cn(sidebarMenuButtonVariants({ size, tone }), className),
    "data-active": isActive || undefined,
    "data-glide": (glide ?? inGroup) || undefined,
    "data-slot": "sidebar-menu-button",
  };
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(defaults, props),
  });
}

/**
 * Hover actions at the end of a row, laid over the row's badge (which turns
 * invisible but keeps its width, so the title never reflows). They show on
 * hover, on keyboard focus, and while `keep` (a menu from them is open).
 */
export function SidebarMenuTrail({ className, keep = false, ...props }: React.ComponentProps<"div"> & { keep?: boolean }) {
  return (
    <div
      data-slot="sidebar-menu-trail"
      data-keep={keep || undefined}
      className={cn(
        "absolute inset-y-0 right-1 hidden items-center gap-0.5 group-has-focus-visible/menu-item:flex group-hover/menu-item:flex data-[keep=true]:flex",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarMenuAction({ className, render, ...props }: useRender.ComponentProps<"button">) {
  const defaults = {
    type: "button" as const,
    className: cn(
      "inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-row-selected hover:text-foreground [&_svg]:size-3.5",
      className,
    ),
    "data-slot": "sidebar-menu-action",
  };
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(defaults, props),
  });
}

/** Trailing text inside a row (a time, a count, a shortcut); gives way to the row's hover actions. */
export function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="sidebar-menu-badge"
      className={cn(
        "ml-auto min-w-6 shrink-0 pl-1 text-right text-2xs text-subtle-foreground tabular-nums group-has-focus-visible/menu-item:invisible group-hover/menu-item:invisible group-data-[keep=true]/menu-item:invisible",
        className,
      )}
      {...props}
    />
  );
}

const WIDTHS = ["62%", "48%", "71%", "55%", "38%", "66%", "44%"];

export function SidebarMenuSkeleton({ index = 0, icon = false, className }: { index?: number; icon?: boolean; className?: string }) {
  return (
    <div className={cn("flex h-7 items-center gap-2 px-2", className)} data-slot="sidebar-menu-skeleton" aria-hidden>
      {icon ? <Skeleton className="size-4 shrink-0 rounded-xs" /> : null}
      <Skeleton className="h-2.5" style={{ width: WIDTHS[index % WIDTHS.length] }} />
    </div>
  );
}

/** Rows nested under a parent row, indented to line up with the parent's label. */
export function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul className={cn("flex min-w-0 flex-col gap-px", className)} data-slot="sidebar-menu-sub" {...props} />;
}
