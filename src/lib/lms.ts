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

/** A course site connected in this vault. `courses` are the ids of the imported courses. */
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
      /** As spaces see it, e.g. "courses/Calculus II". */
      folder: string;
      /** Course files in the folder (downloaded now or already up to date). */
      files: number;
      /** Documents linked from the course, saved in readings/. */
      readings: number;
      /** Web pages linked from the course, listed in links.md. */
      links: number;
      /** What couldn't be imported, each in plain words. */
      skipped: string[];
      /** What its documents are made of (typed, handwriting, pictures). */
      material?: MaterialSummary;
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
 * Course sites belong to the whole vault: one sign-in serves every space.
 */
export const lmsConnect = (kind: LmsKind, address: string, schoolName?: string) =>
  invoke<LmsConnection>("lms_connect", schoolName ? { kind, address, schoolName } : { kind, address });

/** Every course site connected in this vault. Never asks the keychain (`signedIn` is a saved hint). */
export const lmsConnections = () => invoke<LmsConnection[]>("lms_connections");

/** Rejects with `LMS_SIGNED_OUT` when the session has ended. */
export const lmsCourses = (connection: string) => invoke<LmsCourse[]>("lms_courses", { connection });

/**
 * Import (or update) the chosen courses into the vault's `courses/`, streaming `onEvent`.
 * `spaces` may see every part of each course imported for the first time; a course
 * imported before keeps who can see it.
 */
export function lmsImport(connection: string, courseIds: string[], spaces: string[], onEvent: (e: LmsImportEvent) => void): Promise<void> {
  const channel = new Channel<LmsImportEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("lms_import", { connection, courseIds, spaces, onEvent: channel });
}

/** Sign out: the session leaves the keychain. The connection, its courses and who can see them stay. */
export const lmsDisconnect = (connection: string) => invoke<void>("lms_disconnect", { connection });

// ---- Who can see each course -------------------------------------------------

/** A part of a course a space may be allowed to see. */
export type CoursePart = "overview" | "syllabus" | "assignments" | "announcements" | "files" | "grades";

/** Every part, in the order Settings shows them, with its name in words and what it covers. */
export const COURSE_PARTS: readonly { part: CoursePart; label: string; hint: string }[] = [
  { part: "overview", label: "Overview", hint: "The course’s summary and when things are due" },
  { part: "syllabus", label: "Syllabus", hint: "The syllabus" },
  { part: "assignments", label: "Assignments", hint: "Assignments and their due dates" },
  { part: "announcements", label: "Announcements", hint: "Announcements" },
  { part: "files", label: "Files", hint: "Course files, readings, pages and links" },
  { part: "grades", label: "Grades", hint: "Your grades" },
];

/** One imported course. `key` names it in `courseAccessSet`. */
export type CourseInfo = {
  key: string;
  connection: string;
  courseId: string;
  name: string;
  code?: string;
  term?: string;
  /** As spaces see it, e.g. "courses/Calculus II". */
  folder: string;
  /** What its documents are made of, from the last import. */
  material?: MaterialSummary;
};

/** Mirrors `Summary` in src-tauri/src/lms/material.rs: what a course's documents are made of. */
export type MaterialSummary = {
  documents: number;
  /** Documents with nothing flagged. */
  typedDocuments: number;
  /** Pages read by text recognition (handwriting, scans). */
  handwritingPages: number;
  /** Pages nothing could be read from. */
  unreadablePages: number;
  /** Pictures (figures, diagrams, photos) that can't be read as text. */
  pictures: number;
  /** How well the handwriting was read, when there is any. */
  readability?: "good" | "fair" | "poor";
  knownWords?: number;
  /** Why handwriting couldn't be read on the computer that imported it, with what to do. */
  cantRecognise?: string;
  /** The report in sentences, most important first. */
  lines: string[];
  flagged: { path: string; handwriting: number; unreadable: number; pictures: number; knownWords?: number }[];
};

export type CourseAccessView = {
  /** Every space in the vault. */
  spaces: string[];
  /** Every imported course in the vault, by name. */
  courses: CourseInfo[];
  /** Space → course key → the parts it may see (only the asked space when one was named). */
  access: Record<string, Record<string, CoursePart[]>>;
  /** Plain-language notes on entries of course-access.json that were ignored. */
  problems: string[];
};

/** Which courses each space may see (or only `space`'s access, when named). */
export const courseAccessGet = (space?: string) => invoke<CourseAccessView>("course_access_get", space ? { space } : {});

/** Let `space` see `parts` of `course` (`[]`: nothing). */
export const courseAccessSet = (space: string, course: string, parts: CoursePart[]) => invoke<void>("course_access_set", { space, course, parts });

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

/** One imported course's grades, as kept in `<vault>/.phaethon/grades.json` (also written as `<folder>/grades.md`). */
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

/** The grades `space` may see, from disk (fast, no network), by course name. */
export const lmsGrades = (space: string) => invoke<CourseGradeView[]>("lms_grades", { space });

/** Read only the grades again from the site, for each course from `connection` whose grades `space` may see. */
export function lmsGradesRefresh(space: string, connection: string, onEvent: (e: LmsGradesEvent) => void): Promise<void> {
  const channel = new Channel<LmsGradesEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("lms_grades_refresh", { space, connection, onEvent: channel });
}
