import type { SVGProps } from "react";

import { cn } from "@/lib/utils";

import { GLYPHS } from "./glyphs";
import type { IconName } from "./names";

export type { IconName } from "./names";
export { ICON_NAMES } from "./names";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  name: IconName;
  /** Give the icon a name only when it carries meaning on its own (no visible text beside it). */
  label?: string;
};

/**
 * steward's icon. Drawn on a 24 x 24 grid with round joins; its size and stroke
 * width come from tokens (--st-icon-size, --st-icon-stroke) and its colour from
 * the text around it. Decorative unless `label` is given.
 */
export function Icon({ name, label, className, style, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon={name}
      className={cn("size-(--st-icon-size) shrink-0", className)}
      style={{ strokeWidth: "var(--st-icon-stroke)", ...style }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true, focusable: false })}
      {...rest}
    >
      {GLYPHS[name]}
    </svg>
  );
}
