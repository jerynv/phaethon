import { type ComponentProps, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  /** Measure only when the pointer comes over it, for rows in a long windowed list that mount by the dozen while scrolling. */
  lazy?: boolean;
}) {
  return lazy ? <LazyTruncate {...props} /> : <EagerTruncate {...props} />;
}

type TruncateProps = Omit<ComponentProps<"span">, "children"> & { children: ReactNode; tooltip?: ReactNode; side?: "top" | "bottom" | "left" | "right" };

/** Opens after the app's tooltip delay (App.tsx's provider), as a hovered trigger would. */
const LAZY_DELAY = 400;

function LazyTruncate({ children, tooltip, className, side = "top", onPointerEnter, onPointerLeave, ...props }: TruncateProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef(0);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const span = (
    <span
      ref={ref}
      className={cn("block min-w-0 truncate", className)}
      onPointerEnter={(e) => {
        const el = ref.current;
        const isCut = !!el && el.scrollWidth > el.clientWidth + 1;
        setCut(isCut);
        clearTimeout(timer.current);
        if (isCut) timer.current = window.setTimeout(() => setOpen(true), LAZY_DELAY);
        onPointerEnter?.(e);
      }}
      onPointerLeave={(e) => {
        clearTimeout(timer.current);
        setOpen(false);
        onPointerLeave?.(e);
      }}
      {...props}
    >
      {children}
    </span>
  );
  if (!cut) return span;
  // The trigger only places the popup; opening and closing follow the pointer over the text.
  return (
    <Tooltip open={open} onOpenChange={(o) => !o && setOpen(false)}>
      <TooltipTrigger render={span} />
      <TooltipPopup side={side}>{tooltip ?? children}</TooltipPopup>
    </Tooltip>
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
