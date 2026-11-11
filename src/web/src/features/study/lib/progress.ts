/**
 * How far along a streamed study job is, as one 0..1 value for a determinate
 * bar. Making a deck or quiz runs through steps (reading, making, checking,
 * saving) that each report their own done/total; each step owns a slice of
 * the bar, and the bar never moves back (a second "making" round for
 * replacements keeps where it was). Pure.
 */
import type { StudyStep } from "./types";

const MAKE: Partial<Record<StudyStep, [number, number]>> = {
  mapping: [0, 0.25],
  reading: [0.25, 0.35],
  making: [0.35, 0.55],
  checking: [0.55, 0.94],
  saving: [0.94, 1],
};

export type JobKind = "make" | "single";

/** The bar's value for a progress event, never below `prev`. */
export function jobFraction(p: { step: string; done: number; total: number }, kind: JobKind, prev = 0): number {
  const part = p.total > 0 ? Math.max(0, Math.min(1, p.done / p.total)) : 0;
  const range = kind === "make" ? MAKE[p.step as StudyStep] : undefined;
  const value = range ? range[0] + (range[1] - range[0]) * part : part;
  return Math.max(prev, Math.min(1, value));
}

/** "4/12" when a step counts more than one thing, else nothing. */
export function countText(p: { step?: string; done: number; total: number } | null | undefined): string {
  // These steps already say their count in words (progressWords).
  if (!p || p.total <= 1 || p.step === "checking" || p.step === "mapping") return "";
  return `${Math.min(p.done, p.total)}/${p.total}`;
}
