import { expect, test } from "vitest";

import { itemPercent, newlyGraded, newlyText, scoreText } from "./newly";
import type { CourseGradeView, GradeItem } from "./types";

const item = (title: string, graded: boolean, extra: Partial<GradeItem> = {}): GradeItem => ({
  title,
  graded,
  submitted: graded,
  late: false,
  missing: false,
  excused: false,
  comments: [],
  ...extra,
});
const course = (courseId: string, name: string, items: GradeItem[]): CourseGradeView => ({ connection: "c1", courseId, course: name, folder: `courses/${name}`, updated: 0, current: {}, groups: [], items });

test("newly graded: by title and occurrence within a course, never across courses", () => {
  const before = [course("1", "Calc", [item("Quiz", true), item("Quiz", false), item("HW", false)]), course("2", "Psych", [item("Quiz", false)])];
  const after = [
    course("1", "Calc", [item("Quiz", true), item("Quiz", true, { score: 8, possible: 10 }), item("HW", false)]),
    course("2", "Psych", [item("Quiz", false)]),
  ];
  const n = newlyGraded(before, after);
  expect(n).toHaveLength(1);
  expect(newlyText(n[0]!)).toBe("Quiz in Calc, 8/10");
  expect(newlyGraded(after, after)).toEqual([]);
});

test("score and percent as the table shows them", () => {
  expect(scoreText(item("a", true, { score: 18, possible: 20 }))).toBe("18/20");
  expect(scoreText(item("a", false, { possible: 20 }))).toBe("–/20");
  expect(scoreText(item("a", true, { grade: "complete" }))).toBe("complete");
  expect(scoreText(item("a", true, { score: 5, possible: 10, excused: true }))).toBe("–");
  expect(itemPercent(item("a", true, { score: 18, possible: 20 }))).toBe(90);
  expect(itemPercent(item("a", false, { score: 18, possible: 20 }))).toBeNull();
});
