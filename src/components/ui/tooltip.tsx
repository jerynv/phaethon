// Adapted from shadcn/ui (MIT, https://github.com/shadcn-ui/ui), restyled onto Phaethon tokens.
import * as React from "react"
import { cn } from "cn"
import { Tooltip as TooltipPrimitive } from "radix-ui"

/*
 * Small and quick: a short wait before the first tooltip (so passing the
 * pointer over a toolbar does not flash labels), then instant while moving
 * between neighbours. Callers may still pass their own delayDuration.
 */
function TooltipProvider({
  delayDuration = 350,
  skipDelayDuration = 250,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-50 w-fit max-w-(--ph-measure) origin-(--radix-tooltip-content-transform-origin) rounded-sm bg-ink px-2 py-1 text-xs leading-snug font-medium text-balance text-ink-inverse shadow",
          "animate-in duration-(--ph-duration-fast) fade-in-0 zoom-in-[0.97]",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

/*
 * A tooltip for an icon button that already has its name (aria-label). It
 * shows the name for sighted people on hover and focus. Radix always adds the
 * tooltip as the button's description while it is open, so the spoken text is
 * `spoken` (a shortcut, or what the button leads to), never the name again.
 */
function IconTip({ label, spoken, children, side = "top" }: { label: string; spoken: string; children: React.ReactElement; side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"] }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} aria-label={spoken}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, IconTip }
