import { type ComponentProps, type ReactNode, useLayoutEffect, useRef, useState } from "react";
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
  children,
  tooltip,
  className,
  side = "top",
  ...props
}: Omit<ComponentProps<"span">, "children"> & { children: ReactNode; tooltip?: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
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
 * A path cut from the start so its end stays visible: "…/courses/m301/hw6.pdf".
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
