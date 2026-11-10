// STUB: owned by lms
import { Refusal } from "../rpc/registry.ts";

/**
 * Placeholder for the course-access layer so storage code typechecks and runs
 * before the lms worker's branch is merged. The real module replaces this file.
 * With the stub, no space sees any course.
 */

export function visibleCourses(_space: string): { courses: unknown[] } {
  return { courses: [] };
}

/** The real path of a visible `courses/...` path (folder or file), or a Refusal. */
export function resolveCoursePath(_space: string, rel: string, _mustExist: boolean): string {
  throw new Refusal(`"${rel}" isn’t among the courses this space can see`);
}

export function courseIndexForPrompt(_space: string): string | null {
  return null;
}

export function fullyVisibleCourseDirs(_space: string): { label: string; path: string }[] {
  return [];
}
