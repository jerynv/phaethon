import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { CheckIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { HUE_PRESETS } from "./spaces";

/**
 * A space's colour: eight named swatches as a radio group. A hue saved
 * outside the presets shows as an extra, selected swatch so it isn't lost.
 */
export function HuePicker({
  value,
  onValueChange,
  labelId,
  className,
}: {
  value: number;
  onValueChange(hue: number): void;
  labelId?: string;
  className?: string;
}) {
  const presets: { label: string; value: number }[] = [...HUE_PRESETS];
  if (!presets.some((p) => p.value === value)) presets.push({ label: `Current colour (hue ${Math.round(value)})`, value });
  return (
    <RadioGroupPrimitive
      aria-labelledby={labelId}
      value={String(value)}
      onValueChange={(v) => onValueChange(Number(v))}
      className={cn("flex flex-wrap gap-1.5", className)}
    >
      {presets.map((p) => (
        <RadioPrimitive.Root
          key={p.value}
          value={String(p.value)}
          aria-label={p.label}
          title={p.label}
          data-target=""
          style={{ "--swatch": p.value } as CSSProperties}
          className={cn(
            "group/swatch relative inline-flex size-8 cursor-pointer items-center justify-center rounded-full outline-none sm:size-7",
            "bg-[oklch(0.6_0.12_var(--swatch))] dark:bg-[oklch(0.68_0.11_var(--swatch))]",
            "ring-offset-2 ring-offset-background data-checked:ring-2 data-checked:ring-foreground/70",
            "focus-visible:ring-2 focus-visible:ring-ring forced-colors:border forced-colors:border-[CanvasText]",
          )}
        >
          <CheckIcon aria-hidden="true" className="size-4 text-white opacity-0 group-data-checked/swatch:opacity-100 dark:text-black" />
        </RadioPrimitive.Root>
      ))}
    </RadioGroupPrimitive>
  );
}
