// Adapted from shadcn/ui (MIT, https://github.com/shadcn-ui/ui), restyled onto Phaethon tokens.
import * as React from "react"
import { cn } from "cn"
import { Tooltip as TooltipPrimitive } from "radix-ui"
import { TooltipSurface } from "vic-ui"

/*
 * Small and quick: a short wait before the first tooltip (so passing the
 * pointer over a toolbar does not flash labels), then instant while moving
 * between neighbours. Callers may still pass their own delayDuration.
 */
// Keep the compound Radix API and aria-label overrides used for spoken shortcuts.
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
      <TooltipSurface asChild><TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "relative! inset-auto! z-50 w-fit max-w-(--ph-measure) origin-(--radix-tooltip-content-transform-origin) text-balance",
          "animate-in duration-(--ph-duration-fast) fade-in-0 zoom-in-[0.97]",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content></TooltipSurface>
    </TooltipPrimitive.Portal>
  )
}

/*
 * Keep the visible name separate from the shortcut spoken as its description.
 * The compound adapter preserves caller refs, slots and Radix event composition.
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
