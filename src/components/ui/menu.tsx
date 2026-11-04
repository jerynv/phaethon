import type { ComponentProps } from "react";
import { ContextMenu as ContextPrimitive, DropdownMenu as DropdownPrimitive, Popover as PopoverPrimitive } from "radix-ui";
import { MenuSurface, PopoverSurface } from "vic-ui";

import { cn } from "@/lib/utils";

// Radix keeps keyboard navigation, selection, focus restoration and collision placement;
// Vic renders every floating frame. Position stays in the controller's outer wrapper.
const placed = "relative! inset-auto! m-0! forced-colors:border forced-colors:border-[CanvasText]";

function DropdownContent({ className, ...props }: ComponentProps<typeof DropdownPrimitive.Content>) {
  return <MenuSurface asChild><DropdownPrimitive.Content {...props} className={cn(placed, className)} /></MenuSurface>;
}
function DropdownSubContent({ className, ...props }: ComponentProps<typeof DropdownPrimitive.SubContent>) {
  return <MenuSurface asChild><DropdownPrimitive.SubContent {...props} className={cn(placed, className)} /></MenuSurface>;
}
function ContextContent({ className, ...props }: ComponentProps<typeof ContextPrimitive.Content>) {
  return <MenuSurface asChild><ContextPrimitive.Content {...props} className={cn(placed, className)} /></MenuSurface>;
}
function ContextSubContent({ className, ...props }: ComponentProps<typeof ContextPrimitive.SubContent>) {
  return <MenuSurface asChild><ContextPrimitive.SubContent {...props} className={cn(placed, className)} /></MenuSurface>;
}
function PopoverContent({ className, ...props }: ComponentProps<typeof PopoverPrimitive.Content>) {
  return <PopoverSurface asChild><PopoverPrimitive.Content {...props} className={cn(placed, className)} /></PopoverSurface>;
}

export const DropdownMenu = { ...DropdownPrimitive, Content: DropdownContent, SubContent: DropdownSubContent };
export const ContextMenu = { ...ContextPrimitive, Content: ContextContent, SubContent: ContextSubContent };
export const Popover = { ...PopoverPrimitive, Content: PopoverContent };
