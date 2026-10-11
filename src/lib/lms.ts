import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Course sites (Canvas, Brightspace, Moodle, Blackboard). Mirrors the commands
 * in src-tauri/src/lib.rs (`lms_*`) and the types in src-tauri/src/lms/service.rs.
 * The sign-in itself happens in a separate window the core opens on the
 * school's own page; its session stays in the core and the keychain, never here.
 */
export type LmsKind = "canvas" | "brightspace" | "moodle" | "blackboard";

/** A school found by name (Canvas only). `address` is the site's https origin. */
export type LmsSchool = { name: string; address: string };

/** A course site this space is connected to. `courses` are the ids of the imported courses. */
export type LmsConnection = {
  id: string;
  kind: LmsKind;
  address: string;
  schoolName?: string;
  /** False once the session is gone (expired, or removed from the keychain): sign in again. */
  signedIn: boolean;
  /** When the last import finished, in ms since the epoch. */
  lastSync?: number;
  courses: string[];
};

export type LmsCourse = {
  id: string;
  name: string;
  code?: string;
  term?: string;
  /** Running now, as far as the site says. */
  current: boolean;
  imported: boolean;
};

/** What an import step is doing: reading the course from the site, its files, links out of it, writing the folder. */
export type LmsImportStep = "reading" | "files" | "readings" | "writing";

/**
 * Streamed by `lmsImport`, ending with exactly one `done`. `course` is a course id.
 * An `error` with `message === LMS_SIGNED_OUT` means the session ended: sign in
 * again, then import again (only what changed is downloaded). Any other `error`
 * is about one course, in plain words, and the import goes on with the next one.
 */
export type LmsImportEvent =
  | { type: "progress"; course: string; step: LmsImportStep; done: number; total: number }
  | {
      type: "course";
      course: string;
      /** Relative to the space, e.g. "courses/Calculus II". */
      folder: string;
      /** Course files in the folder (downloaded now or already up to date). */
      files: number;
      /** Documents linked from the course, saved in readings/. */
      readings: number;
      /** Web pages linked from the course, listed in links.md. */
      links: number;
      /** What couldn't be imported, each in plain words. */
      skipped: string[];
    }
  | { type: "done" }
  | { type: "error"; message: string };

/** The error text when the session has ended (lms_courses rejects with it; lms_import sends it). */
export const LMS_SIGNED_OUT = "signedOut";
/** The error text when the person closed the sign-in window. */
export const LMS_CANCELLED = "cancelled";

/** Canvas schools whose name matches `query`; `[]` for the other kinds (ask for the address instead). */
export const lmsSchools = (kind: LmsKind, query: string) => invoke<LmsSchool[]>("lms_schools", { kind, query });

/**
 * Open the sign-in window at `address` and resolve once the person has signed in.
 * Rejects with `LMS_CANCELLED` when the window is closed. The same kind and address
 * again (Sign in again) keeps the connection's id and imported courses.
 * `schoolName` (optional, e.g. from `lmsSchools`) titles the window and is kept as the connection's `schoolName`.
 */
export const lmsConnect = (space: string, kind: LmsKind, address: string, schoolName?: string) =>
  invoke<LmsConnection>("lms_connect", schoolName ? { space, kind, address, schoolName } : { space, kind, address });

export const lmsConnections = (space: string) => invoke<LmsConnection[]>("lms_connections", { space });

/** Rejects with `LMS_SIGNED_OUT` when the session has ended. */
export const lmsCourses = (space: string, connection: string) =>
  invoke<LmsCourse[]>("lms_courses", { space, connection });

/** Import (or update) the chosen courses into `<space>/courses/`, streaming `onEvent`. */
export function lmsImport(
  space: string,
  connection: string,
  courseIds: string[],
  onEvent: (e: LmsImportEvent) => void,
): Promise<void> {
  const channel = new Channel<LmsImportEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("lms_import", { space, connection, courseIds, onEvent: channel });
}

/** Forget the session and the connection; imported files stay in the space. */
export const lmsDisconnect = (space: string, connection: string) =>
  invoke<void>("lms_disconnect", { space, connection });

// ---- Grades ----------------------------------------------------------------

/** A grade in a few numbers; any of them may be missing (a course without letters, a grade not released). */
export type GradeSummary = {
  /** 0–100. */
  percent?: number;
  letter?: string;
  points?: number;
  possible?: number;
};

/** An assignment group (category). `weight` (0–100, share of the course grade) only when the course weights its groups. */
export type GradeGroup = { name: string; weight?: number };

/** One graded thing. A grade the course hasn't released has no `score` and `graded: false`; that isn't an error. */
export type GradeItem = {
  title: string;
  /** The `name` of its group in `CourseGradeView.groups`, if any. */
  group?: string;
  score?: number;
  possible?: number;
  /** 0–100. */
  percent?: number;
  /** The grade as the site shows it when it isn't just the score ("A-", "complete", "Satisfactory"). */
  grade?: string;
  /** RFC 3339. */
  due?: string;
  submitted: boolean;
  graded: boolean;
  late: boolean;
  missing: boolean;
  excused: boolean;
  /** The teacher's comments, plain text. */
  comments: string[];
};

/** One imported course's grades, as kept in `<space>/.phaethon/grades.json` (also written as `<folder>/grades.md`). */
export type CourseGradeView = {
  connection: string;
  courseId: string;
  /** The course's name. */
  course: string;
  /** Relative to the space, e.g. "courses/Calculus II". */
  folder: string;
  /** When they were read from the site, ms since the epoch. */
  updated: number;
  /** The grade so far (only graded work counts). */
  current: GradeSummary;
  /** With ungraded work counted as zero, when the site gives it and it differs. */
  final?: GradeSummary;
  groups: GradeGroup[];
  items: GradeItem[];
  /** Why there's nothing to show, in plain words (the course hides its grade book). */
  note?: string;
};

/**
 * Streamed by `lmsGradesRefresh`, ending with exactly one `done`. `course` is a course id.
 * An `error` with `message === LMS_SIGNED_OUT` means the session ended (the refresh stops there);
 * any other `error` is about one course, in plain words, and the refresh goes on.
 */
export type LmsGradesEvent =
  | { type: "progress"; course: string; step: "grades"; done: number; total: number }
  | { type: "course"; course: string; grades: CourseGradeView }
  | { type: "done" }
  | { type: "error"; message: string };

/** Every imported course's grades in `space`, from disk (fast, no network), by course name. */
export const lmsGrades = (space: string) => invoke<CourseGradeView[]>("lms_grades", { space });

/** Read only the grades again from the site, for each course imported from `connection`. */
export function lmsGradesRefresh(space: string, connection: string, onEvent: (e: LmsGradesEvent) => void): Promise<void> {
  const channel = new Channel<LmsGradesEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("lms_grades_refresh", { space, connection, onEvent: channel });
}
