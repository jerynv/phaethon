import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/** A space's mark: its initial on its own hue. Decorative; the name is always beside it. */
export function SpaceMark({ name, hue, className }: { name: string; hue: number; className?: string }) {
  const initial = [...name.trim()][0]?.toLocaleUpperCase() ?? "?";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-6 shrink-0 select-none items-center justify-center rounded-md font-semibold text-[0.75rem] leading-none",
        "bg-[oklch(0.56_0.12_var(--mark-hue))] text-[oklch(0.99_0_0)] dark:bg-[oklch(0.66_0.11_var(--mark-hue))] dark:text-[oklch(0.17_0.02_var(--mark-hue))]",
        "forced-colors:border forced-colors:border-[CanvasText]",
        className,
      )}
      style={{ "--mark-hue": hue } as CSSProperties}
    >
      {initial}
    </span>
  );
}
