import { cx, type CxOptions } from "class-variance-authority";
import { extendTailwindMerge } from "tailwind-merge";

// The extra font sizes are sizes, not colours, so later ones replace earlier ones.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["2xs", "3xs"] } },
});

/** Joins class names and lets later Tailwind utilities win over earlier ones. */
export function cn(...inputs: CxOptions): string {
  return twMerge(cx(inputs));
}
