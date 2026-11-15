import { cn } from "@/lib/utils";

/**
 * Phaethon's mark (build/brand/mark.png) as a single-colour path, so it takes
 * `currentColor` and sizes with `size-*`. The welcome screen, onboarding and
 * the sidebar's top row use it; the app icon stays the raster in build/.
 */
export function BrandMark({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      viewBox="200 150 624 724"
      className={cn("size-5 shrink-0", className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      fill="currentColor"
    >
      <path d="M224 852V330c0-110 66-160 156-160h245c115 0 175 70 175 180v128l-112-65v-63c0-40-20-62-63-62H400c-40 0-58 20-58 60v154c0 26 14 42 42 42h241c45 0 63-34 63-82l112 64c-2 74-60 134-175 134H342v162c0 20-10 30-30 30z" />
    </svg>
  );
}
