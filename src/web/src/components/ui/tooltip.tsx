// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT. See THIRD_PARTY_NOTICES.md.
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  createContext,
  use,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from "react";

import { cn } from "@/lib/utils";

// Base UI's default, restated because a padding object zeroes the sides it omits.
const COLLISION_PADDING = 5;
const TOOLTIP_COLLISION_PADDING = {
  top: COLLISION_PADDING,
  right: COLLISION_PADDING,
  bottom: COLLISION_PADDING,
  left: COLLISION_PADDING,
} as const;

const TooltipProvider = TooltipPrimitive.Provider;

type TooltipActionsRef = RefObject<TooltipPrimitive.Root.Actions | null>;

// The compiler freezes context values; update hovered tooltips through calls instead of shared ref writes.
function createTooltipHoverTracker() {
  let hovered: { trigger: HTMLElement; actionsRef: TooltipActionsRef } | null = null;
  return {
    hover(trigger: HTMLElement, actionsRef: TooltipActionsRef) {
      hovered = { trigger, actionsRef };
    },
    release(actionsRef: TooltipActionsRef) {
      if (hovered?.actionsRef === actionsRef) hovered = null;
    },
    dismissUnfocused() {
      const tooltip = hovered;
      if (!tooltip) return;
      const focused = tooltip.trigger.ownerDocument.activeElement;
      if (focused && tooltip.trigger.contains(focused) && focused.matches(":focus-visible")) {
        return;
      }
      hovered = null;
      // Base UI also cancels delayed hover opens through this action.
      tooltip.actionsRef.current?.close();
    },
  };
}

type TooltipHoverTracker = ReturnType<typeof createTooltipHoverTracker>;
const TooltipHoverContext = createContext<TooltipActionsRef | null>(null);
const TooltipScrollContext = createContext<TooltipHoverTracker | null>(null);

function TooltipScrollDismissArea({ onScrollCapture, ...props }: ComponentProps<"div">) {
  const [tracker] = useState(createTooltipHoverTracker);
  return (
    <TooltipScrollContext value={tracker}>
      <div
        {...props}
        onScrollCapture={(event) => {
          onScrollCapture?.(event);
          tracker.dismissUnfocused();
        }}
      />
    </TooltipScrollContext>
  );
}

function Tooltip<Payload>(props: TooltipPrimitive.Root.Props<Payload>) {
  const tracker = use(TooltipScrollContext);
  const localActionsRef = useRef<TooltipPrimitive.Root.Actions | null>(null);
  const actionsRef = props.actionsRef ?? localActionsRef;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases this tooltip from the scroll tracker on unmount
  useEffect(() => () => tracker?.release(actionsRef), [actionsRef, tracker]);

  if (!tracker) return <TooltipPrimitive.Root {...props} />;
  return (
    <TooltipHoverContext value={actionsRef}>
      <TooltipPrimitive.Root
        {...props}
        actionsRef={actionsRef}
        onOpenChange={(open, details) => {
          props.onOpenChange?.(open, details);
          if (!open && !details.isCanceled) tracker.release(actionsRef);
        }}
      />
    </TooltipHoverContext>
  );
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  const tracker = use(TooltipScrollContext);
  const actionsRef = use(TooltipHoverContext);
  if (!tracker || !actionsRef) {
    return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
  }
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onMouseEnter={(event) => {
        props.onMouseEnter?.(event);
        tracker.hover(event.currentTarget, actionsRef);
      }}
    />
  );
}

function TooltipPositioner(props: TooltipPrimitive.Positioner.Props) {
  return (
    <TooltipPrimitive.Positioner
      className="pointer-events-none z-(--z-tooltip) max-w-(--available-width) transition-transform data-instant:transition-none"
      collisionPadding={TOOLTIP_COLLISION_PADDING}
      data-slot="tooltip-positioner"
      {...props}
    />
  );
}

function TooltipPopup({
  className,
  align = "center",
  sideOffset = 6,
  side = "top",
  variant = "default",
  anchor,
  children,
  ...props
}: TooltipPrimitive.Popup.Props & {
  align?: TooltipPrimitive.Positioner.Props["align"];
  side?: TooltipPrimitive.Positioner.Props["side"];
  sideOffset?: TooltipPrimitive.Positioner.Props["sideOffset"];
  variant?: "default" | "glass" | "code";
  anchor?: TooltipPrimitive.Positioner.Props["anchor"];
}) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPositioner align={align} anchor={anchor} side={side} sideOffset={sideOffset}>
        <TooltipPrimitive.Popup
          className={cn(
            "relative flex origin-(--transform-origin) text-left text-xs transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0 data-instant:duration-0",
            // The references' tooltip (7cad "Copy", 95ba "Codex"): a near-black pill, white text, keys in a lighter tint.
            variant === "glass"
              ? "dropdown-glass rounded-md text-popover-foreground shadow-popup"
              : "rounded-lg bg-tooltip text-tooltip-foreground [&_[data-slot=kbd]]:bg-tooltip-foreground/15 [&_[data-slot=kbd]]:text-tooltip-foreground/80",
            variant === "code"
              ? "max-w-120 wrap-anywhere text-left font-mono text-2xs leading-relaxed"
              : "max-w-80 wrap-anywhere whitespace-normal",
            className,
          )}
          data-slot="tooltip-popup"
          {...props}
        >
          <div className={cn("min-w-0", variant === "default" ? "px-2.5 py-1.5" : "px-2 py-1")} data-slot="tooltip-viewport">
            {children}
          </div>
        </TooltipPrimitive.Popup>
      </TooltipPositioner>
    </TooltipPrimitive.Portal>
  );
}

export { TooltipProvider, Tooltip, TooltipTrigger, TooltipPopup, TooltipScrollDismissArea };
