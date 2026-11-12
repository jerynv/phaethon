import { cn } from "@/lib/utils";

/** Three rising bars, filled up to the level's place among the model's levels (after T3 Code's EffortGlyph). */
export function EffortGlyph({ level, levels, className }: { level: string; levels: string[]; className?: string }) {
  const at = Math.max(0, levels.indexOf(level));
  const filled = levels.length <= 1 ? 3 : Math.round((at / (levels.length - 1)) * 2) + 1;
  return (
    <svg viewBox="0 0 12 12" className={cn("shrink-0", className)} aria-hidden>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={1 + i * 4} y={8 - i * 3} width={2.4} height={3 + i * 3} rx={0.8} fill="currentColor" opacity={i < filled ? 1 : 0.25} />
      ))}
    </svg>
  );
}
