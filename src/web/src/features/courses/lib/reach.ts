/** What a space can see of the vault's courses, and whether a view's empty state should say so. Pure. */
import type { CourseAccessView, CoursePart } from "./types";

export type CourseReach = {
  /** Courses imported in the vault, whoever can see them. */
  imported: number;
  /** Courses this space can see, and which parts. */
  seen: Record<string, CoursePart[]>;
};

export function reachOf(view: CourseAccessView, space: string): CourseReach {
  const known = new Set(view.courses.map((c) => c.key));
  const seen = Object.fromEntries(Object.entries(view.access[space] ?? {}).filter(([k, p]) => known.has(k) && p.length > 0));
  return { imported: view.courses.length, seen };
}

/**
 * "none" when the space sees no course although some are imported; "part" when
 * no course it sees includes any wanted part; null otherwise (or unknown).
 */
export function hiddenCourses(reach: CourseReach | null, part?: CoursePart | CoursePart[]): "none" | "part" | null {
  if (!reach || reach.imported === 0) return null;
  const seen = Object.values(reach.seen);
  if (seen.length === 0) return "none";
  const want = part ? [part].flat() : null;
  if (want && !seen.some((p) => want.some((w) => p.includes(w)))) return "part";
  return null;
}

/** How many of the courses a space sees lack every wanted part (they show nothing in that view). */
export function coursesWithout(reach: CourseReach | null, part: CoursePart | CoursePart[]): number {
  if (!reach) return 0;
  const want = [part].flat();
  return Object.values(reach.seen).filter((p) => !want.some((w) => p.includes(w))).length;
}
