/**
 * How decks and quizzes are named and grouped on Study's overview
 * (docs/UI-REBUILD.md › Study › Overview): a card never repeats its course.
 * Its name loses a leading course code or course name when that is the
 * card's own course, and a space with several courses groups its cards under
 * each course once. Pure, so vitest runs it (shelf.test.ts).
 */
import type { CourseSource } from "./types";

/** A course as the overview knows it: its folder's name (what a deck's `course` holds), its name and code. */
export type ShelfCourse = { folder: string; name: string; code?: string };

/** Course codes are letters then a number: "MTH 214", "CS101", "MATH-2414", "ECON 2301.001". */
const CODE = /([A-Za-z]{2,5})[\s_-]?(\d{2,4}[A-Za-z]?)(?:[.-]\d{1,3})?/;
const LEADING_CODE = new RegExp(`^${CODE.source}(?=$|[^A-Za-z0-9])`);
const ALL_CODES = new RegExp(`(?<![A-Za-z0-9])${CODE.source}(?![A-Za-z0-9])`, "g");
const SEPARATORS = /^[\s:·•|–—,/-]+/;

const codeKey = (letters: string, number: string) => `${letters}${number}`.toLowerCase();
const folderName = (folder: string) => folder.replace(/^courses\//, "");

/** Every code a course goes by: its own, and any written in its name. */
function codesOf(course: ShelfCourse): Set<string> {
  const out = new Set<string>();
  for (const text of [course.code ?? "", course.name, folderName(course.folder)]) {
    for (const m of text.matchAll(ALL_CODES)) out.add(codeKey(m[1]!, m[2]!));
  }
  return out;
}

/** `text` without a leading `prefix` (any case), when the prefix ends at a word boundary. */
function dropPrefix(text: string, prefix: string): string | null {
  const p = prefix.trim();
  if (!p || text.length < p.length || text.slice(0, p.length).toLowerCase() !== p.toLowerCase()) return null;
  const rest = text.slice(p.length);
  return rest === "" || /^[^\p{L}\p{N}]/u.test(rest) ? rest : null;
}

/**
 * A deck's or quiz's name without its course in front: "MTH 214 Test 1
 * practice" in MTH 214 is "Test 1 practice"; "Calculus II: Series" in
 * Calculus II is "Series". A prefix of another course stays, and a name that
 * would be left empty keeps its whole self.
 */
export function shortName(title: string, course: ShelfCourse | undefined): string {
  const whole = title.trim();
  if (!course) return whole;
  const names = [course.name, folderName(course.folder)].filter((n, i, all) => n.trim() && all.indexOf(n) === i);
  const dropName = (t: string) => {
    for (const n of names) {
      const rest = dropPrefix(t, n);
      if (rest !== null) return rest;
    }
    return null;
  };
  let rest = dropName(whole);
  if (rest === null) {
    const m = LEADING_CODE.exec(whole);
    if (m && codesOf(course).has(codeKey(m[1]!, m[2]!))) {
      rest = whole.slice(m[0].length);
      // "MTH 214 Logic and Discrete Math: Test 1": the name can follow the code.
      rest = dropName(rest.replace(SEPARATORS, "")) ?? rest;
    }
  }
  if (rest === null) return whole;
  const short = rest.replace(SEPARATORS, "").trim();
  if (!short) return whole;
  return short[0]!.toLocaleUpperCase() + short.slice(1);
}

/** The course a deck's or quiz's `course` names, among what the space sees; one it no longer sees stands for itself. */
export function courseOf(course: string | undefined, sources: readonly Pick<CourseSource, "name" | "folder" | "code">[]): ShelfCourse | undefined {
  if (!course?.trim()) return undefined;
  const found = sources.find((s) => folderName(s.folder) === course || s.name === course);
  return found ? { folder: found.folder, name: found.name, ...(found.code ? { code: found.code } : {}) } : { folder: `courses/${course}`, name: course };
}

export type Shelf<T> = { course: ShelfCourse | undefined; items: T[] };

/**
 * Cards grouped by course, courses by name and cards without one last. With
 * one group there is nothing to tell apart, so the overview draws no label.
 */
export function shelves<T extends { course?: string }>(items: readonly T[], sources: readonly Pick<CourseSource, "name" | "folder" | "code">[]): Shelf<T>[] {
  const groups = new Map<string, Shelf<T>>();
  for (const item of items) {
    const course = courseOf(item.course, sources);
    const key = course?.folder ?? "";
    const group = groups.get(key) ?? { course, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (!a.course ? 1 : !b.course ? -1 : a.course.name.localeCompare(b.course.name)));
}
