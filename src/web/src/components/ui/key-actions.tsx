import type * as React from "react";
import { cn } from "@/lib/utils";
import { Kbd } from "./kbd";

/**
 * The bar of keyed choices under an approval card ("Y Accept & send · N
 * Reject"): equal cells split by a hairline, each with its keycap. The keys
 * themselves are bound by the card that owns the bar.
 */
function KeyActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="key-actions" role="group" className={cn("grid auto-cols-fr grid-flow-col divide-x overflow-hidden rounded-xl border bg-card", className)} {...props} />;
}

function KeyAction({ shortcut, className, children, ...props }: React.ComponentProps<"button"> & { shortcut: string }) {
  return (
    <button
      type="button"
      data-slot="key-action"
      aria-keyshortcuts={shortcut}
      className={cn(
        "flex h-11 items-center gap-3 px-4 text-left text-base text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-60",
        className,
      )}
      {...props}
    >
      <Kbd variant="keycap">{shortcut}</Kbd>
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

export { KeyAction, KeyActions };
