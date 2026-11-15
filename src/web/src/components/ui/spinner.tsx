import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A faint ring with a turning arc, after the references' "Thinking…" mark.
 * No default size: inside a Button the parent's svg rule sizes the glyph.
 */
const spinnerVariants = cva("shrink-0", {
  variants: {
    size: {
      xs: "size-3",
      sm: "size-3.5",
      md: "size-4",
      lg: "size-5",
    },
    tone: {
      current: "",
      muted: "text-muted-foreground",
    },
  },
  defaultVariants: { tone: "current" },
});

function Spinner({ className, size, tone, ...props }: React.ComponentProps<"svg"> & VariantProps<typeof spinnerVariants>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-label="Loading" role="status" data-slot="spinner" className={cn(spinnerVariants({ size, tone }), className)} {...props}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.75" opacity="0.18" />
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray="11 40"
        className="origin-center animate-spin-fast"
      />
    </svg>
  );
}

export { Spinner };
