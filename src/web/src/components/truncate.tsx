import { createContext, type ComponentProps, type ReactNode, type Ref, use, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { observeResize } from "@/lib/observe-resize";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** True while the element's text is cut off. */
function useIsCut<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setCut(el.scrollWidth > el.clientWidth + 1);
    check();
    return observeResize(el, check);
  });
  return [ref, cut] as const;
}

/**
 * One line with an ellipsis; the full text shows in a tooltip only when it's
 * actually cut. For titles, names and model names (docs/UI-REBUILD.md ›
 * Overflow).
 */
export function Truncate({
  lazy = false,
  ...props
}: Omit<ComponentProps<"span">, "children"> & {
  children: ReactNode;
  tooltip?: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  /** Measure only when the pointer comes over it and use the shared tooltip of the `TruncateTips` around it, for rows in a long windowed list that mount by the dozen while scrolling. */
  lazy?: boolean;
}) {
  return lazy ? <LazyTruncate {...props} /> : <EagerTruncate {...props} />;
}

type TruncateProps = Omit<ComponentProps<"span">, "children"> & { children: ReactNode; tooltip?: ReactNode; side?: "top" | "bottom" | "left" | "right" };

/** Opens after the app's tooltip delay (App.tsx's provider), as a hovered trigger would. */
const LAZY_DELAY = 400;

type Tip = { el: HTMLElement; content: ReactNode; side: "top" | "bottom" | "left" | "right" };
type Tips = { show(tip: Tip): void; hide(el?: HTMLElement): void };
const TipsContext = createContext<Tips | null>(null);

/**
 * One tooltip shared by every lazy `Truncate` inside, anchored to whichever
 * title is hovered. The titles stay plain spans (no trigger of their own), so
 * hovering never swaps the element a press started on, and a long windowed
 * list mounts no tooltip machinery per row. `suppressed` keeps it shut (a menu
 * of the list is open); `hideRef` closes it from outside (the list scrolled).
 */
export function TruncateTips({
  children,
  suppressed = false,
  hideRef,
  anchorOf,
}: {
  children: ReactNode;
  suppressed?: boolean;
  hideRef?: Ref<(() => void) | null>;
  /** What the tooltip sits beside, given the hovered title (its row, so it clears the row's hover actions). */
  anchorOf?: (title: HTMLElement) => Element | null;
}) {
  const [tip, setTip] = useState<Tip | null>(null);
  const last = useRef<Tip | null>(null);
  if (tip) last.current = tip;
  const timer = useRef(0);
  const tips = useMemo<Tips>(
    () => ({
      show(t) {
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setTip(t), LAZY_DELAY);
      },
      hide(el) {
        clearTimeout(timer.current);
        setTip((t) => (!el || t?.el === el ? null : t));
      },
    }),
    [],
  );
  useImperativeHandle(hideRef, () => () => tips.hide(), [tips]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (suppressed) tips.hide();
  }, [suppressed, tips]);
  const shown = tip ?? last.current;
  return (
    <TipsContext value={tips}>
      {children}
      <Tooltip open={!!tip && !suppressed && tip.el.isConnected} onOpenChange={(o) => !o && tips.hide()}>
        <TooltipPopup side={shown?.side ?? "top"} anchor={shown ? (anchorOf?.(shown.el) ?? shown.el) : undefined}>
          {shown?.content}
        </TooltipPopup>
      </Tooltip>
    </TipsContext>
  );
}

function LazyTruncate({ children, tooltip, className, side = "top", onPointerEnter, onPointerLeave, onPointerDown, onContextMenu, ...props }: TruncateProps) {
  const tips = use(TipsContext);
  const ref = useRef<HTMLSpanElement>(null);
  if (!tips) return <EagerTruncate tooltip={tooltip} className={className} side={side} {...props}>{children}</EagerTruncate>;
  // Measured only when the pointer arrives; the element itself never changes.
  return (
    <span
      ref={ref}
      className={cn("block min-w-0 truncate", className)}
      onPointerEnter={(e) => {
        const el = ref.current;
        if (el && e.pointerType !== "touch" && el.scrollWidth > el.clientWidth + 1) tips.show({ el, content: tooltip ?? children, side });
        onPointerEnter?.(e);
      }}
      onPointerLeave={(e) => {
        tips.hide(ref.current ?? undefined);
        onPointerLeave?.(e);
      }}
      onPointerDown={(e) => {
        tips.hide(ref.current ?? undefined);
        onPointerDown?.(e);
      }}
      onContextMenu={(e) => {
        tips.hide(ref.current ?? undefined);
        onContextMenu?.(e);
      }}
      {...props}
    >
      {children}
    </span>
  );
}

function EagerTruncate({ children, tooltip, className, side = "top", ...props }: TruncateProps) {
  const [ref, cut] = useIsCut<HTMLSpanElement>();
  const span = <span ref={ref} className={cn("block min-w-0 truncate", className)} {...props}>{children}</span>;
  if (!cut) return span;
  return (
    <Tooltip>
      <TooltipTrigger render={span} />
      <TooltipPopup side={side}>{tooltip ?? children}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * A path cut from the start so its end stays visible: "…/courses/math301/problem-set-6.pdf".
 * Uses direction: rtl on the outer box with an isolated inner run, so the
 * browser places the ellipsis on the left without reordering the text.
 */
export function StartTruncate({ value, className }: { value: string; className?: string }) {
  const [ref, cut] = useIsCut<HTMLSpanElement>();
  const span = (
    <span ref={ref} className={cn("block min-w-0 truncate text-left [direction:rtl]", className)}>
      <bdi className="[direction:ltr] [unicode-bidi:isolate]">{value}</bdi>
    </span>
  );
  if (!cut) return span;
  return (
    <Tooltip>
      <TooltipTrigger render={span} />
      <TooltipPopup side="top" variant="code">
        {value}
      </TooltipPopup>
    </Tooltip>
  );
}
