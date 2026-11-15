// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT. See THIRD_PARTY_NOTICES.md.
import type * as React from "react";

import { cn } from "@/lib/utils";

function Kbd({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"kbd"> & {
  /** `keycap` is the slightly larger grey key of an approval choice ("Y Accept", "N Reject"); `outline` is the same as the default. */
  variant?: "default" | "outline" | "keycap";
}) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-4 min-w-4 select-none items-center justify-center gap-1 rounded-xs px-1 font-sans text-2xs text-muted-foreground tabular-nums [&_svg:not([class*='size-'])]:size-3",
        variant === "keycap" ? "h-5 min-w-5 rounded-sm bg-muted px-1.5 text-xs" : "bg-foreground/6",
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn("inline-flex items-center gap-0.5", className)}
      data-slot="kbd-group"
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
