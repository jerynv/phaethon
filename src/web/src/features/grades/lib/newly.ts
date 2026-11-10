/**
 * What a refresh newly graded: items graded now that weren't before, matched
 * within each course by title and by which occurrence of that title they are
 * (courses repeat titles like "Quiz"), never across courses. Pure.
 */
import type { CourseGradeView, GradeItem } from "./types";

const keyed = (items: GradeItem[]) => {
  const seen = new Map<string, number>();
  return items.map((i) => {
    const n = seen.get(i.title) ?? 0;
    seen.set(i.title, n + 1);
    return { key: `${i.title}\u0000${n}`, item: i };
  });
};

export function newlyGraded(before: CourseGradeView[], after: CourseGradeView[]): { course: string; item: GradeItem }[] {
  const out: { course: string; item: GradeItem }[] = [];
  for (const c of after) {
    const old = before.find((b) => b.connection === c.connection && b.courseId === c.courseId);
    const was = new Map(keyed(old?.items ?? []).map((x) => [x.key, x.item]));
    for (const { key, item } of keyed(c.items)) {
      if (item.graded && !item.excused && !was.get(key)?.graded) out.push({ course: c.course, item });
    }
  }
  return out;
}

/** "Homework 3 in Calculus II, 17/20". */
export function newlyText(n: { course: string; item: GradeItem }): string {
  const s = n.item.score != null && n.item.possible ? `, ${n.item.score}/${n.item.possible}` : n.item.grade ? `, ${n.item.grade}` : "";
  return `${n.item.title} in ${n.course}${s}`;
}

/** The score as the table shows it. */
export function scoreText(i: GradeItem): string {
  if (i.excused) return "–";
  if (i.score != null && i.possible) return `${i.score}/${i.possible}`;
  if (i.score != null) return String(i.score);
  if (i.grade) return i.grade;
  if (i.possible) return `–/${i.possible}`;
  return "–";
}

/** The item's percent, when graded and not excused. */
export function itemPercent(i: GradeItem): number | null {
  if (!i.graded || i.excused) return null;
  if (i.percent != null) return i.percent;
  if (i.score != null && i.possible) return (i.score / i.possible) * 100;
  return null;
}
