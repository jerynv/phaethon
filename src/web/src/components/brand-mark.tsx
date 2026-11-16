import { cn } from "@/lib/utils";

/**
 * Phaethon's mark (build/brand/mark.png) as a single-colour path in Phaethon's
 * blue (`text-primary`), sized with `size-*`. The welcome screen, onboarding and
 * the sidebar's top row use it; the app icon stays the raster in build/.
 */
export function BrandMark({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      viewBox="200 150 624 724"
      className={cn("size-5 shrink-0 text-primary", className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      fill="currentColor"
    >
      <path d="M224 852V330c0-110 66-160 156-160h245c115 0 175 70 175 180v128l-112-65v-63c0-40-20-62-63-62H400c-40 0-58 20-58 60v154c0 26 14 42 42 42h241c45 0 63-34 63-82l112 64c-2 74-60 134-175 134H342v162c0 20-10 30-30 30z" />
    </svg>
  );
}

/**
 * "Phaethon" with the mark as its P: the mark at the cap height of 18 px
 * Inter (13 px of glyph in its 14 px box), then "haethon" on the same
 * baseline, in the weight that matches the mark's strokes. While the name
 * shows, pass `relative top-px` in `markClassName` to seat the glyph's foot on
 * the baseline.
 */
export function BrandWordmark({
  className,
  markClassName,
  nameClassName,
  showName = true,
}: {
  className?: string;
  markClassName?: string;
  /** For hiding the name when there's no room (a container query), leaving the mark. */
  nameClassName?: string;
  showName?: boolean;
}) {
  return (
    <span role="img" aria-label="Phaethon" className={cn("inline-flex shrink-0 select-none items-baseline", className)}>
      {/* The glyph's foot sits a pixel above its box's bottom: next to the name it drops onto the text's baseline. */}
      <BrandMark className={cn("size-3.5", markClassName)} />
      {showName ? (
        <span aria-hidden className={cn("-ml-px font-semibold text-foreground text-xl leading-none tracking-title", nameClassName)}>
          haethon
        </span>
      ) : null}
    </span>
  );
}
