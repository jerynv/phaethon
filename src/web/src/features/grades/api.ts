/** Typed calls for Grades (the old Tauri commands, one to one). */
import { Channel, invoke } from "@/lib/core";

import { untilTerminal, type StreamEnd } from "../courses/lib/stream";
import type { CourseGradeView, GradesEvent } from "./lib/types";

export const lmsGrades = (space: string) => invoke<CourseGradeView[]>("lms_grades", { space });

/** Read the grades of `connection`'s courses again; ends on the stream's terminal event. */
export function lmsGradesRefresh(space: string, connection: string, onEvent: (e: GradesEvent) => void): Promise<StreamEnd> {
  return untilTerminal<GradesEvent>(
    (on) => invoke<void>("lms_grades_refresh", { space, connection, onEvent: new Channel<GradesEvent>(on) }),
    onEvent,
    (e) => e.type === "done",
  );
}
