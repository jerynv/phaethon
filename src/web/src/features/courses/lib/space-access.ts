/**
 * The space ↔ course access list (Settings › Courses): readable course names,
 * the order spaces are offered in, and how the course rows group and filter.
 */
import type { CourseAccessView, CourseInfo, SpaceSummary } from "./types";

import { shortCourseName } from "./course-name";

export { shortCourseName };

/** Study spaces first, then by name. */
export function sortSpaces<T extends Pick<SpaceSummary, "id" | "name" | "educationEnabled">>(list: T[]): T[] {
  return [...list].sort((a, b) => Number(!!b.educationEnabled) - Number(!!a.educationEnabled) || a.name.localeCompare(b.name));
}

/** Who sees a course: spaces that see every part, and spaces that see only some. */
export type CourseSpaces = { all: string[]; some: string[] };

export function spacesOf(view: CourseAccessView, course: string, partCount: number): CourseSpaces {
  const all: string[] = [];
  const some: string[] = [];
  for (const space of view.spaces) {
    const n = view.access[space]?.[course]?.length ?? 0;
    if (n >= partCount) all.push(space);
    else if (n > 0) some.push(space);
  }
  return { all, some };
}

export type CourseRow = { course: CourseInfo; label: string; reach: CourseSpaces };
export type CourseGroup = { id: string; label?: string; rows: CourseRow[] };

/**
 * Rows for the access list: filtered by `query` (short name, raw name or
 * code), grouped by school only when there is more than one, and split into
 * the courses some space sees and the ones no space does.
 */
export function courseGroups(
  view: CourseAccessView,
  opts: { partCount: number; query?: string; schoolOf: (course: CourseInfo) => string | undefined },
): { groups: CourseGroup[]; hidden: CourseRow[]; total: number } {
  const q = (opts.query ?? "").trim().toLowerCase();
  const rows = view.courses
    .map((course) => ({ course, label: shortCourseName(course.name), reach: spacesOf(view, course.key, opts.partCount) }))
    .filter((r) => !q || r.label.toLowerCase().includes(q) || r.course.name.toLowerCase().includes(q) || (r.course.code ?? "").toLowerCase().includes(q))
    .sort((a, b) => a.label.localeCompare(b.label) || a.course.key.localeCompare(b.course.key));
  const seen = rows.filter((r) => r.reach.all.length || r.reach.some.length);
  const hidden = rows.filter((r) => !r.reach.all.length && !r.reach.some.length);
  const schools = new Set(view.courses.map((c) => opts.schoolOf(c) ?? ""));
  if (schools.size <= 1) return { groups: seen.length ? [{ id: "all", rows: seen }] : [], hidden, total: rows.length };
  const bySchool = new Map<string, CourseRow[]>();
  for (const r of seen) {
    const k = opts.schoolOf(r.course) ?? "";
    bySchool.set(k, [...(bySchool.get(k) ?? []), r]);
  }
  const groups = [...bySchool.entries()]
    .sort(([a], [b]) => (a ? (b ? a.localeCompare(b) : -1) : 1))
    .map(([k, list]) => ({ id: k || "other", label: k || "Other", rows: list }));
  return { groups, hidden, total: rows.length };
}
