import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * A space's identity: its initial on a square in its hue, kept quiet (a pale
 * tint with a deeper letter) so it never outshouts the row it sits in.
 */
export function SpaceAvatar({ name, hue, className }: { name: string; hue: number; className?: string }) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? "·";
  return (
    <span
      aria-hidden
      className={cn("space-avatar inline-flex size-4 shrink-0 select-none items-center justify-center rounded-sm font-medium text-3xs leading-none", className)}
      style={{ "--hue": hue } as CSSProperties}
    >
      {initial}
    </span>
  );
}
