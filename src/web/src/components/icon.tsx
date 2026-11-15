import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { IconContext } from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
// Default size (16 px) comes from index.css at zero specificity, so a parent's `[&_svg]:size-*` still applies.

/**
 * Icon rules, in one place (docs/UI-REBUILD.md › Icons).
 *
 * - One family: Hugeicons stroke-rounded (`@hugeicons/core-free-icons`, MIT).
 *   Pick glyphs through the semantic map in `components/icons.ts`, not by
 *   importing from the package in a feature, so one concept always has one
 *   glyph. Brand marks stay as they are (`components/provider-icon.tsx`).
 * - Size with Tailwind's `size-*` only: `size-4` (16 px) in chrome, rows and
 *   menus, `size-3.5` in small buttons and chips, `size-3` inline, `size-5`
 *   for the leading glyph of an action card or empty state.
 * - Stroke is set in CSS from `--icon-stroke` (1.5) and `--icon-stroke-small`
 *   (1.75 at 12–14 px). Never pass `strokeWidth`.
 * - Icons are decorative by default (`aria-hidden`). Give the button around
 *   it an `aria-label`; pass `label` only for an icon that stands alone and
 *   means something.
 */
export type IconData = IconSvgElement;

type IconProps = Omit<ComponentProps<typeof HugeiconsIcon>, "icon" | "strokeWidth" | "size" | "absoluteStrokeWidth"> & {
  icon: IconData;
  /** Accessible name for an icon that carries meaning on its own. */
  label?: string;
};

export function Icon({ icon, label, className, ...props }: IconProps) {
  return (
    <HugeiconsIcon
      icon={icon}
      data-slot="icon"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable={false}
      className={cn("shrink-0", className)}
      {...props}
    />
  );
}

/**
 * Phosphor still draws a few not-yet-migrated places; its Light weight is the
 * closest to Hugeicons' stroke. Remove once `rg phosphor-icons src/web` is empty.
 */
export function IconProvider({ children }: { children: ReactNode }) {
  return <IconContext.Provider value={{ weight: "light", size: "1em" }}>{children}</IconContext.Provider>;
}
