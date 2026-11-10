import { cx, type CxOptions } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

/** Joins class names and lets later Tailwind utilities win over earlier ones. */
export function cn(...inputs: CxOptions): string {
  return twMerge(cx(inputs));
}
