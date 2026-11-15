/**
 * Letter grades as grade points, for the term's GPA on the Grades page. The
 * standard 4.0 scale by default; Settings › General lets the person set the
 * points for each letter when their school counts differently. Pure (gpa.test.ts).
 */
export type GradeScale = { kind: "standard" } | { kind: "custom"; points: Record<string, number> };

export const LETTER_ORDER = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"] as const;

export const STANDARD_POINTS: Readonly<Record<string, number>> = Object.freeze({
  "A+": 4,
  A: 4,
  "A-": 3.7,
  "B+": 3.3,
  B: 3,
  "B-": 2.7,
  "C+": 2.3,
  C: 2,
  "C-": 1.7,
  "D+": 1.3,
  D: 1,
  "D-": 0.7,
  F: 0,
});

export const STANDARD: GradeScale = { kind: "standard" };

export function pointsOf(scale: GradeScale): Readonly<Record<string, number>> {
  return scale.kind === "custom" ? { ...STANDARD_POINTS, ...scale.points } : STANDARD_POINTS;
}

/** The scale's top mark ("4.0" in "3.4 / 4.0"). */
export function scaleMax(scale: GradeScale): number {
  return Math.max(0, ...Object.values(pointsOf(scale)).filter((n) => Number.isFinite(n)));
}

/** Points for a letter as a site writes it ("A-", " b+ ", "A−"); null for anything else ("P", "complete"). */
export function pointsFor(letter: string | undefined, scale: GradeScale): number | null {
  if (!letter) return null;
  const key = letter.trim().toUpperCase().replace(/[−–]/g, "-");
  const n = pointsOf(scale)[key];
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** The unweighted mean of the letters the scale knows, to two decimals, and how many counted; null when none do. */
export function termGpa(letters: readonly (string | undefined)[], scale: GradeScale): { gpa: number; counted: number } | null {
  const points = letters.map((l) => pointsFor(l, scale)).filter((n): n is number => n !== null);
  if (!points.length) return null;
  const mean = points.reduce((a, b) => a + b, 0) / points.length;
  return { gpa: Math.round(mean * 100) / 100, counted: points.length };
}

/** "3.4", "4.0": GPA with one decimal, two when the second matters ("3.67"). */
export function gpaText(n: number): string {
  const two = n.toFixed(2);
  return two.endsWith("0") ? n.toFixed(1) : two;
}

/** A pref read from storage, checked: unknown shapes fall back to the standard scale. */
export function readScale(raw: unknown): GradeScale {
  if (!raw || typeof raw !== "object") return STANDARD;
  const o = raw as { kind?: unknown; points?: unknown };
  if (o.kind !== "custom" || !o.points || typeof o.points !== "object") return STANDARD;
  const points: Record<string, number> = {};
  for (const [k, v] of Object.entries(o.points as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 20) points[k] = v;
  return { kind: "custom", points };
}
