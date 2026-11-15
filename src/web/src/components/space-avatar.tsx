import { cn } from "@/lib/utils";

/** A space's identity: its initial on a square in its hue. */
export function SpaceAvatar({ name, hue, className }: { name: string; hue: number; className?: string }) {
  const initial = [...name.trim()][0]?.toUpperCase() ?? "·";
  return (
    <span
      aria-hidden
      className={cn("inline-flex size-4 shrink-0 select-none items-center justify-center rounded-[4px] font-semibold text-[9px] text-white leading-none", className)}
      style={{ background: `oklch(0.62 0.14 ${hue})` }}
    >
      {initial}
    </span>
  );
}
