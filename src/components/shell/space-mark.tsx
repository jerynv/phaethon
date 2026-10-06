import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

/** Style that gives an element (and everything inside it) a space's hue. */
export function spaceHueStyle(hue: number): CSSProperties {
  return { "--ph-space-h": String(hue) } as CSSProperties;
}

/**
 * The quiet mark that identifies a space: a small dot in the space's hue.
 * Decorative: the space's name always sits next to it. A space whose hue is
 * unknown (not in this vault's list) gets a neutral dot.
 */
export function SpaceMark({ hue, className }: { hue: number | undefined; className?: string }) {
  if (hue === undefined) {
    return <span aria-hidden="true" className={cn("inline-block size-(--ph-space-mark-size) shrink-0 rounded-full bg-ink-tertiary", className)} />;
  }
  return (
    <span
      aria-hidden="true"
      data-space-hue=""
      style={spaceHueStyle(hue)}
      className={cn("inline-block size-(--ph-space-mark-size) shrink-0 rounded-full bg-space-mark", className)}
    />
  );
}
