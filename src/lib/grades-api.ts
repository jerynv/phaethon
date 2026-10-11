/**
 * Grades for the views: the core's commands and types (src/lib/lms.ts, mirroring
 * src-tauri/src/lms/service.rs), under the names the grades view uses, plus a
 * time helper.
 */
export { lmsGrades, lmsGradesRefresh, type GradeGroup, type GradeItem } from "@/lib/lms";
export type { CourseGradeView as CourseGrades, GradeSummary as GradeNumbers, LmsGradesEvent as GradesRefreshEvent } from "@/lib/lms";

/** A time from the core as ms since the epoch, or null when it can't be read. */
export function timeOf(t: string | number | undefined | null): number | null {
  if (t == null || t === "") return null;
  const ms = typeof t === "number" ? (t < 1e11 ? t * 1000 : t) : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}
