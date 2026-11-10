/**
 * One course context per space, shared by Study, Grades and Plan. Course
 * folders arrive with and without the `courses/` prefix (Plan's are bare,
 * Study's and the access list's carry it), so every comparison goes through
 * `folderKey`, and a selection always holds the prefixed folder. Keys of
 * imported courses are `<connection>/<courseId>`; a course known only by its
 * folder (decks naming a course that isn't imported) is `folder:<name>`.
 * Pure.
 */
import type { CourseInfo } from "./types";

export type CourseSelection = { key: string; folder: string; name: string };
export type CourseChoice = { key?: string; connection?: string; courseId?: string; folder: string; name: string };

/** A folder without the `courses/` prefix, trimmed: "courses/Calculus II" and "Calculus II" are the same. */
export const folderKey = (folder: string) => folder.replace(/^courses\//, "").replace(/\/+$/, "").trim();
/** The folder as spaces see it: always "courses/<name>". */
export const courseFolder = (folder: string) => `courses/${folderKey(folder)}`;
export const sameFolder = (a: string, b: string) => folderKey(a).toLowerCase() === folderKey(b).toLowerCase();
/** The key an imported course is known by everywhere. */
export const courseKey = (connection: string, courseId: string) => `${connection}/${courseId}`;
/** The key of a course known only by its folder. */
export const folderOnlyKey = (folder: string) => `folder:${folderKey(folder)}`;

/** The pseudo-course for decks and quizzes that name none. */
export const GENERAL = "uncategorized";

/** What a choice selects: the imported course it names (by key or folder), else the choice itself. */
export function resolveChoice(courses: readonly CourseInfo[], choice: CourseChoice | null): CourseSelection | null {
  if (!choice) return null;
  const imported = courses.find((c) => c.key === choice.key || sameFolder(c.folder, choice.folder));
  if (imported) return { key: imported.key, folder: courseFolder(imported.folder), name: imported.name };
  if (choice.folder === GENERAL) return { key: GENERAL, folder: GENERAL, name: choice.name };
  return {
    key: choice.key ?? (choice.connection && choice.courseId ? courseKey(choice.connection, choice.courseId) : folderOnlyKey(choice.folder)),
    folder: courseFolder(choice.folder),
    name: choice.name,
  };
}

/**
 * The selection after the space's courses were read again: an imported match
 * takes its canonical form; a folder-only or general choice stays; a course
 * the space can no longer see is cleared.
 */
export function reconcile(courses: readonly CourseInfo[], picked: CourseSelection | null): CourseSelection | null {
  if (!picked) return null;
  const imported = courses.find((c) => c.key === picked.key || sameFolder(c.folder, picked.folder));
  if (imported) return { key: imported.key, folder: courseFolder(imported.folder), name: imported.name };
  return picked.key.startsWith("folder:") || picked.key === GENERAL ? picked : null;
}

/**
 * Whether something saved with course `saved` (a name or folder) belongs to
 * the selected course. The general pseudo-course matches only things with
 * no course.
 */
export function courseMatches(saved: string | undefined, folder: string, name: string): boolean {
  if (folder === GENERAL) return !saved?.trim();
  if (!saved?.trim()) return false;
  const k = (s: string) => folderKey(s).toLowerCase();
  return k(saved) === k(folder) || k(saved) === k(name);
}

/** The courses a space can see: those it has at least one part of. */
export function visibleCourses(view: { courses: CourseInfo[]; access: Record<string, Record<string, string[]>> }, space: string): CourseInfo[] {
  return view.courses.filter((c) => (view.access[space]?.[c.key]?.length ?? 0) > 0);
}

/** Courses sorted as a person reads a list: by code, else name, numbers in order. */
export function byCode<T extends { code?: string; name: string }>(a: T, b: T): number {
  return (a.code || a.name).localeCompare(b.code || b.name, undefined, { numeric: true, sensitivity: "base" });
}
