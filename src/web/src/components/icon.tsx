import { IconContext } from "@phosphor-icons/react";
import type { ReactNode } from "react";

/**
 * Icon rules, in one place, so icons from different libraries sit together.
 *
 * - Pick the icon that reads best in each place, from any library: Lucide,
 *   Phosphor, Tabler, Hugeicons. Brands come from `assets/providers/`.
 * - Size with Tailwind's `size-*` only: `size-4` (16 px) in chrome, rows and
 *   menus, `size-3.5` in small buttons and chips, `size-3` inside 20 px
 *   controls and inline text.
 * - Stroke is set here, not per icon. Lucide's stroke comes from
 *   `--icon-stroke` in index.css (thinner at 16 px, a touch heavier at 12 px
 *   so small glyphs don't fade); Phosphor uses its Light weight through the
 *   provider below. Pass `weight="fill"` only for a status mark that must read
 *   as solid (the pinned mark, a stop square).
 */
export function IconProvider({ children }: { children: ReactNode }) {
  return <IconContext.Provider value={{ weight: "light", size: "1em" }}>{children}</IconContext.Provider>;
}
