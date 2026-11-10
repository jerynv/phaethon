/** Typed calls for course sites, course access and course content (the old Tauri commands, one to one). */
import { Channel, invoke } from "@/lib/core";

import { untilTerminal, type StreamEnd } from "./lib/stream";
import type {
  CourseAccessView,
  CourseContent,
  CoursePart,
  LmsConnection,
  LmsCourse,
  LmsImportEvent,
  LmsKind,
  LmsSchool,
  SpaceSummary,
} from "./lib/types";

export const lmsSchools = (kind: LmsKind, query: string) => invoke<LmsSchool[]>("lms_schools", { kind, query });
/** Opens the sign-in window natively; rejects "cancelled" when it is closed. */
export const lmsConnect = (kind: LmsKind, address: string, schoolName?: string) =>
  invoke<LmsConnection>("lms_connect", schoolName ? { kind, address, schoolName } : { kind, address });
export const lmsConnections = () => invoke<LmsConnection[]>("lms_connections");
export const lmsCourses = (connection: string) => invoke<LmsCourse[]>("lms_courses", { connection });
export const lmsImportCancel = (connection: string) => invoke<boolean>("lms_import_cancel", { connection });
export const lmsDisconnect = (connection: string) => invoke<void>("lms_disconnect", { connection });
export const courseAccessGet = (space?: string) => invoke<CourseAccessView>("course_access_get", space ? { space } : {});
export const courseAccessSet = (space: string, course: string, parts: CoursePart[]) => invoke<void>("course_access_set", { space, course, parts });
export const lmsCourseContent = (space: string, course: string) => invoke<CourseContent>("lms_course_content", { space, course });
export const spacesList = () => invoke<SpaceSummary[]>("spaces_list");

/** Import the chosen courses; ends on the stream's terminal event (see lib/stream.ts). */
export function lmsImport(connection: string, courseIds: string[], spaces: string[], onEvent: (e: LmsImportEvent) => void): Promise<StreamEnd> {
  return untilTerminal<LmsImportEvent>(
    (on) => {
      const channel = new Channel<LmsImportEvent>(on);
      return invoke<void>("lms_import", { connection, courseIds, spaces, onEvent: channel });
    },
    onEvent,
    (e) => e.type === "done" || e.type === "cancelled",
  );
}
