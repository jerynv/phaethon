/** Grades' wire types (research F-ui §1b). */
export type GradeSummary = { percent?: number; letter?: string; points?: number; possible?: number };
export type GradeGroup = { name: string; weight?: number };
export type GradeItem = {
  title: string;
  group?: string;
  score?: number;
  possible?: number;
  percent?: number;
  /** The grade as the site shows it when it isn't just the score ("A-", "complete"). */
  grade?: string;
  /** RFC 3339 */
  due?: string;
  submitted: boolean;
  graded: boolean;
  late: boolean;
  missing: boolean;
  excused: boolean;
  comments: string[];
};
export type CourseGradeView = {
  connection: string;
  courseId: string;
  course: string;
  folder: string;
  updated: number;
  current: GradeSummary;
  final?: GradeSummary;
  groups: GradeGroup[];
  items: GradeItem[];
  note?: string;
};
export type GradesEvent =
  | { type: "progress"; course: string; step: "grades"; done: number; total: number }
  | { type: "course"; course: string; grades: CourseGradeView }
  | { type: "done" }
  | { type: "error"; message: string };
