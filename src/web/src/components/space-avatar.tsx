import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * A space's colour, as a small dot. The name beside it does the naming; the
 * dot only tells spaces apart at a glance.
 */
export function SpaceAvatar({ hue, className }: { name?: string; hue: number; className?: string }) {
  return <span aria-hidden className={cn("space-dot inline-block size-2 shrink-0 rounded-full", className)} style={{ "--hue": hue } as CSSProperties} />;
}
