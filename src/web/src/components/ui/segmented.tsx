import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A single choice drawn as a segmented control, with radio semantics (one
 * Tab stop, arrows move and choose). Use it for short exclusive options such
 * as theme or text size.
 */
function SegmentedControl<T extends string>({
  className,
  value,
  onValueChange,
  options,
  ...props
}: Omit<RadioGroupPrimitive.Props, "value" | "onValueChange"> & {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; label: React.ReactNode; title?: string; style?: React.CSSProperties }[];
}) {
  return (
    <RadioGroupPrimitive
      className={cn(
        "inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-lg bg-input/40 p-0.5 contrast-more:border contrast-more:border-input",
        className,
      )}
      data-slot="segmented-control"
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
      {...props}
    >
      {options.map((o) => (
        <RadioPrimitive.Root
          key={o.value}
          value={o.value}
          title={o.title}
          style={o.style}
          data-slot="toggle"
          className={cn(
            "inline-flex min-h-8 min-w-8 cursor-pointer select-none items-center justify-center gap-1.5 rounded-md px-3 text-sm text-muted-foreground outline-none transition-colors sm:min-h-7",
            "hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            "data-checked:bg-background data-checked:font-medium data-checked:text-foreground data-checked:shadow-xs/5 dark:data-checked:bg-input/80",
            "contrast-more:data-checked:outline contrast-more:data-checked:outline-1 contrast-more:data-checked:outline-foreground",
            "data-disabled:cursor-not-allowed data-disabled:opacity-64",
          )}
        >
          {o.label}
        </RadioPrimitive.Root>
      ))}
    </RadioGroupPrimitive>
  );
}

export { SegmentedControl };
