/**
 * What Grades puts first: each course's grade and how it moved, then the
 * work that needs attention across courses (due soon, missing or late,
 * graded recently, and the open items worth the most of a course grade),
 * and how the full tables sort and filter. Pure (focus.test.ts).
 */
import { itemWeights, keyedItems, calcItems } from "./table";
import type { CourseGradeView, GradeItem } from "./types";
import { calculate, letterFor, LETTERS, needed, timeOf, trend } from "./what-if";

const DAY = 86_400_000;

export type Ref = { course: CourseGradeView; key: string; item: GradeItem; due: number | null };

function refs(courses: readonly CourseGradeView[]): Ref[] {
  return courses.flatMap((course) => keyedItems(course.items).map(({ key, item }) => ({ course, key, item, due: timeOf(item.due) })));
}

export type CourseHead = {
  course: CourseGradeView;
  percent: number | null;
  letter?: string;
  /** Change in points from the latest graded item, and its title. */
  trend: { delta: number; since: string } | null;
  graded: number;
  open: number;
};

/** A course's grade at a glance: the site's own number when it gives one, else the calculated one. */
export function courseHead(course: CourseGradeView): CourseHead {
  const input = { groups: course.groups, items: calcItems(course) };
  const percent = course.current.percent ?? calculate(input).percent;
  const letter = course.current.letter ?? (percent != null ? letterFor(percent) : undefined);
  return {
    course,
    percent,
    letter,
    trend: trend(input),
    graded: course.items.filter((i) => i.graded && !i.excused).length,
    open: course.items.filter((i) => !i.graded && !i.excused).length,
  };
}

/** Not yet graded or submitted, due from now to `days` ahead, soonest first. */
export function dueSoon(courses: readonly CourseGradeView[], now: number, days = 7): Ref[] {
  return refs(courses)
    .filter((r) => !r.item.graded && !r.item.excused && !r.item.submitted && !r.item.missing && r.due != null && r.due >= now - DAY / 2 && r.due <= now + days * DAY)
    .sort((a, b) => a.due! - b.due!);
}

/** Missing, or late and not yet made up, most recent first. */
export function missingOrLate(courses: readonly CourseGradeView[]): Ref[] {
  return refs(courses)
    .filter((r) => !r.item.excused && (r.item.missing || r.item.late))
    .sort((a, b) => Number(b.item.missing) - Number(a.item.missing) || (b.due ?? 0) - (a.due ?? 0));
}

/** Graded since the last look first, then graded in the last `days`, most recent first. */
export function recentlyGraded(courses: readonly CourseGradeView[], fresh: ReadonlySet<GradeItem>, now: number, days = 14): Ref[] {
  return refs(courses)
    .filter((r) => r.item.graded && !r.item.excused && (fresh.has(r.item) || (r.due != null && r.due >= now - days * DAY && r.due <= now + DAY)))
    .sort((a, b) => Number(fresh.has(b.item)) - Number(fresh.has(a.item)) || (b.due ?? 0) - (a.due ?? 0));
}

export type Lever = Ref & {
  /** Its share of the course grade, in percent. */
  weight: number;
  /** The next letter up and the score needed on this item to reach it (others as they are), when reachable. */
  next?: { letter: string; percent: number };
};

/** The open items worth the most of their course's grade, biggest first. */
export function levers(courses: readonly CourseGradeView[], max = 4): Lever[] {
  const out: Lever[] = [];
  for (const course of courses) {
    const weights = itemWeights(course);
    const input = { groups: course.groups, items: calcItems(course) };
    const now = calculate(input).percent;
    const up = now == null ? null : [...LETTERS].reverse().find(([, min]) => min > now + 0.005);
    for (const { key, item } of keyedItems(course.items)) {
      const w = weights.get(key);
      if (item.graded || item.excused || !w) continue;
      const lever: Lever = { course, key, item, due: timeOf(item.due), weight: w };
      if (up) {
        const n = needed(input, { item: key }, up[1]);
        if (n.kind === "needs") lever.next = { letter: up[0], percent: n.percent };
      }
      out.push(lever);
    }
  }
  return out.sort((a, b) => b.weight - a.weight || (a.due ?? Infinity) - (b.due ?? Infinity)).slice(0, max);
}

// ---- The full tables ----

export type Status = "all" | "open" | "graded" | "attention";
export type SortKey = "due" | "title" | "score" | "weight";
export type Sort = { key: SortKey; dir: 1 | -1 };

const scoreOf = (i: GradeItem) => (i.percent != null ? i.percent : i.score != null && i.possible ? (i.score / i.possible) * 100 : null);

/** A course's rows filtered by text and status and sorted; rows without the sorted value go last either way. */
export function tableRows(course: CourseGradeView, o: { query: string; status: Status; sort: Sort }): { key: string; item: GradeItem; weight: number | null }[] {
  const weights = itemWeights(course);
  const q = o.query.trim().toLowerCase();
  const rows = keyedItems(course.items)
    .map(({ key, item }) => ({ key, item, weight: weights.get(key) ?? null }))
    .filter(({ item }) => !q || item.title.toLowerCase().includes(q) || (item.group ?? "").toLowerCase().includes(q))
    .filter(({ item }) =>
      o.status === "all" ? true : o.status === "open" ? !item.graded && !item.excused : o.status === "graded" ? item.graded && !item.excused : item.missing || item.late,
    );
  const value = (r: (typeof rows)[number]): number | string | null =>
    o.sort.key === "title" ? r.item.title.toLowerCase() : o.sort.key === "due" ? timeOf(r.item.due) : o.sort.key === "score" ? scoreOf(r.item) : r.weight;
  return rows
    .map((r, i) => ({ r, i, v: value(r) }))
    .sort((a, b) => {
      if (a.v == null || b.v == null) return a.v == null && b.v == null ? a.i - b.i : a.v == null ? 1 : -1;
      return (a.v < b.v ? -1 : a.v > b.v ? 1 : 0) * o.sort.dir || a.i - b.i;
    })
    .map(({ r }) => r);
}

/** "Today", "Tomorrow", "Fri", "Oct 3": a due date in words for a dense row. */
export function dueWords(due: number | null, now: number): string {
  if (due == null) return "";
  const start = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const days = Math.round((start(due) - start(now)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days > 1 && days < 7) return new Date(due).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(due).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
