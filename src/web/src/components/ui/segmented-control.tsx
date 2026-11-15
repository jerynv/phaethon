import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Pick one of a few values (docs/UI-REBUILD.md › Primitives › Segmented
 * control). Use Tabs when the choice swaps a panel; use this for a value
 * (a range "1D · 1W · 1M", a mode, a filter). Exactly one is always chosen.
 *
 * - `track` (default): grey track, the chosen item on a white pill that glides.
 * - `outline`: a white bar of cells split by hairlines; the chosen cell turns ink.
 */
type Variant = "track" | "outline";
const Ctx = React.createContext<{ value: string; variant: Variant; group: string }>({ value: "", variant: "track", group: "" });

function SegmentedControl<T extends string>({
  value,
  onValueChange,
  variant = "track",
  className,
  children,
  ...props
}: Omit<ToggleGroupPrimitive.Props, "value" | "defaultValue" | "onValueChange" | "multiple"> & {
  value: T;
  onValueChange: (value: T) => void;
  variant?: Variant;
}) {
  const group = React.useId();
  return (
    <Ctx value={{ value, variant, group }}>
      <LayoutGroup id={group}>
        <ToggleGroupPrimitive
          data-slot="segmented-control"
          data-variant={variant}
          value={[value]}
          onValueChange={(next) => {
            const v = next[0];
            if (v !== undefined && v !== value) onValueChange(v as T);
          }}
          className={cn(
            "relative inline-flex w-fit items-center",
            variant === "track" ? "isolate gap-0.5 rounded-lg bg-muted p-0.5" : "divide-x overflow-hidden rounded-lg border bg-card",
            className,
          )}
          {...props}
        >
          {children}
        </ToggleGroupPrimitive>
      </LayoutGroup>
    </Ctx>
  );
}

function SegmentedControlItem({ value, className, children, ...props }: Omit<TogglePrimitive.Props, "value"> & { value: string }) {
  const ctx = React.use(Ctx);
  const reduce = useReducedMotion();
  const on = ctx.value === value;
  return (
    <TogglePrimitive
      data-slot="segmented-control-item"
      value={value}
      className={cn(
        "relative inline-flex h-7 min-w-9 shrink-0 select-none items-center justify-center gap-1.5 px-3 text-sm outline-none transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&_svg]:size-4",
        ctx.variant === "track" ? "rounded-md font-medium text-muted-foreground hover:text-foreground data-pressed:text-foreground" : "text-muted-foreground hover:bg-accent data-pressed:font-medium data-pressed:text-foreground",
        className,
      )}
      {...props}
    >
      {on && ctx.variant === "track" ? (
        <motion.span
          layoutId={`${ctx.group}-pill`}
          aria-hidden
          className="absolute inset-0 -z-10 rounded-md bg-background shadow-raised dark:bg-accent"
          transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 520, damping: 40 }}
        />
      ) : null}
      {children}
    </TogglePrimitive>
  );
}

export { SegmentedControl, SegmentedControlItem };
