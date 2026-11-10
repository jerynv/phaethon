// STUB: owned by lms
import { Refusal } from "../rpc/registry.ts";

export type VisibleCourse = { folder: string; name: string; code?: string };

/** Courses this space may see (only the parts it may see are reachable through `resolveCoursePath`). */
export function visibleCourses(_space: string): VisibleCourse[] {
  return [];
}

/**
 * A `courses/...` path the agent's tools or file_open accept → the real file or
 * folder, refusing parts the space can't see. `rel` starts with `courses`.
 */
export function resolveCoursePath(_space: string, rel: string, _mustExist: boolean): string {
  throw new Refusal(`"${rel}" does not exist`);
}

/** Hides lines about parts the space can't see (README.md); other text is returned as is. ASSUMED addition (filter_text). */
export function filterCourseText(_space: string, _rel: string, text: string): string {
  return text;
}

export function courseIndexForPrompt(_space: string): string | null {
  return null;
}

export function fullyVisibleCourseDirs(_space: string): { label: string; path: string }[] {
  return [];
}
