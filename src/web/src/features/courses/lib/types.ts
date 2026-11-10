/** Course sites' wire types, as the Tauri commands had them (research F-ui §1b). */

export type LmsKind = "canvas" | "brightspace" | "moodle" | "blackboard";
export type LmsSchool = { name: string; address: string };
export type LmsConnection = { id: string; kind: LmsKind; address: string; schoolName?: string; signedIn: boolean; lastSync?: number; courses: string[] };
export type LmsCourse = { id: string; name: string; code?: string; term?: string; current: boolean; imported: boolean; partial?: boolean };
export type LmsImportStep = "reading" | "files" | "readings" | "writing";

export type MaterialSummary = {
  documents: number;
  typedDocuments: number;
  handwritingPages: number;
  unreadablePages: number;
  pictures: number;
  readability?: "good" | "fair" | "poor";
  knownWords?: number;
  cantRecognise?: string;
  lines: string[];
  flagged: { path: string; handwriting: number; unreadable: number; pictures: number; knownWords?: number }[];
};

export type LmsImportEvent =
  | { type: "progress"; course: string; step: LmsImportStep; done: number; total: number }
  | { type: "course"; course: string; folder: string; files: number; readings: number; links: number; skipped: string[]; material?: MaterialSummary }
  | { type: "cancelled" }
  | { type: "done" }
  | { type: "error"; message: string };

export type CoursePart = "overview" | "syllabus" | "assignments" | "announcements" | "files" | "grades";

/** Every part, in the order the access editor shows them. */
export const COURSE_PARTS: readonly { part: CoursePart; label: string }[] = [
  { part: "overview", label: "Overview" },
  { part: "syllabus", label: "Syllabus" },
  { part: "assignments", label: "Assignments" },
  { part: "announcements", label: "Announcements" },
  { part: "files", label: "Files" },
  { part: "grades", label: "Grades" },
];

export type CourseInfo = {
  /** "<connection>/<courseId>" */
  key: string;
  connection: string;
  courseId: string;
  name: string;
  code?: string;
  term?: string;
  /** As spaces see it: "courses/Calculus II". */
  folder: string;
  material?: MaterialSummary;
};

export type CourseAccessView = {
  spaces: string[];
  courses: CourseInfo[];
  /** Space → course key → the parts it may see. */
  access: Record<string, Record<string, CoursePart[]>>;
  problems: string[];
};

export type CourseContentEntry = {
  path: string;
  title: string;
  kind: "file" | "page" | "module" | "assignment" | "overview";
  anchor?: string;
  headingIndex?: number;
  text?: string;
  bytes?: number;
};
export type CourseContent = { entries: CourseContentEntry[]; updated?: number; truncated?: boolean };

/** A space as the vault lists it (spaces_list). */
export type SpaceSummary = { id: string; name: string; description?: string; hue?: number; educationEnabled?: boolean; lastUsed?: number | null };
