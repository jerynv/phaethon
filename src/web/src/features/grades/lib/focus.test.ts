import { describe, expect, test } from "vitest";
import { categories, courseHead, courseStats, dueSoon, dueWords, gradeSeries, levers, missingOrLate, recentlyGraded, tableRows } from "./focus";
import type { CourseGradeView, GradeItem } from "./types";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const at = (d: number) => new Date(NOW + d * DAY).toISOString();
const item = (title: string, extra: Partial<GradeItem> = {}): GradeItem => ({ title, submitted: false, graded: false, late: false, missing: false, excused: false, comments: [], ...extra });
const graded = (title: string, score: number, possible: number, extra: Partial<GradeItem> = {}) => item(title, { score, possible, graded: true, submitted: true, ...extra });

const course = (name: string, items: GradeItem[], extra: Partial<CourseGradeView> = {}): CourseGradeView => ({
  connection: "c",
  courseId: name,
  course: name,
  folder: `courses/${name}`,
  updated: NOW,
  current: {},
  groups: [],
  items,
  ...extra,
});

const algebra = course(
  "Linear Algebra",
  [
    graded("Set 1", 9, 10, { due: at(-20) }),
    graded("Set 2", 6, 10, { due: at(-3) }),
    item("Set 3", { possible: 10, due: at(2) }),
    item("Set 4", { possible: 10, due: at(9) }),
    item("Set 0", { possible: 10, due: at(-10), missing: true }),
    item("Final", { possible: 100, due: at(30) }),
    item("Reading check", { possible: 10, due: at(1), submitted: true }),
  ],
  { groups: [{ name: "Sets", weight: 40 }, { name: "Exams", weight: 60 }] },
);
algebra.items.forEach((i) => (i.group = i.title === "Final" ? "Exams" : "Sets"));

const art = course("Studio Art", [graded("Sketchbook", 18, 20, { due: at(-1), late: true }), item("Portfolio", { possible: 50, due: at(5) })], { current: { percent: 91, letter: "A-" } });

describe("what comes first", () => {
  test("a course's grade, letter and trend", () => {
    const h = courseHead(algebra);
    // Graded: Set 1 9/10 and Set 2 6/10 in Sets; Set 0 is missing but not graded so it doesn't count.
    expect(h.percent).toBe(75);
    expect(h.letter).toBe("C");
    expect(h.trend?.since).toBe("Set 2");
    expect(h.trend!.delta).toBeCloseTo(-15);
    expect([h.graded, h.open]).toEqual([2, 5]);
    expect(courseHead(art)).toMatchObject({ percent: 91, letter: "A-" });
  });

  test("due soon: open, not submitted, within a week, soonest first", () => {
    expect(dueSoon([algebra, art], NOW).map((r) => r.item.title)).toEqual(["Set 3", "Portfolio"]);
  });

  test("missing before late, most recent first", () => {
    expect(missingOrLate([algebra, art]).map((r) => r.item.title)).toEqual(["Set 0", "Sketchbook"]);
  });

  test("recently graded: new since the last look first", () => {
    const fresh = new Set([algebra.items[0]!]);
    expect(recentlyGraded([algebra, art], fresh, NOW).map((r) => r.item.title)).toEqual(["Set 1", "Sketchbook", "Set 2"]);
  });

  test("levers: the open items worth the most, with the score for the next letter", () => {
    const l = levers([algebra, art], 3);
    expect(l.map((x) => [x.item.title, Math.round(x.weight)])).toEqual([
      ["Portfolio", 71],
      ["Final", 60],
      ["Set 0", 7],
    ]);
    const final = l.find((x) => x.item.title === "Final")!;
    expect(final.next?.letter).toBe("C+");
    expect(final.next!.percent).toBeGreaterThan(0);
  });
});

describe("the full tables", () => {
  test("filter by text and status, sort with empty values last", () => {
    const titles = (o: Parameters<typeof tableRows>[1]) => tableRows(algebra, o).map((r) => r.item.title);
    expect(titles({ query: "", status: "graded", sort: { key: "score", dir: -1 } })).toEqual(["Set 1", "Set 2"]);
    // Text matches the category too ("Sets").
    expect(titles({ query: "set", status: "open", sort: { key: "due", dir: 1 } })).toEqual(["Set 0", "Reading check", "Set 3", "Set 4"]);
    expect(titles({ query: "set 3", status: "all", sort: { key: "due", dir: 1 } })).toEqual(["Set 3"]);
    expect(titles({ query: "", status: "attention", sort: { key: "title", dir: 1 } })).toEqual(["Set 0"]);
    expect(titles({ query: "", status: "all", sort: { key: "weight", dir: -1 } })[0]).toBe("Final");
    expect(titles({ query: "", status: "all", sort: { key: "score", dir: 1 } }).slice(0, 2)).toEqual(["Set 2", "Set 1"]);
  });

  test("due dates in a few words", () => {
    expect(dueWords(NOW, NOW)).toBe("Today");
    expect(dueWords(NOW + DAY, NOW)).toBe("Tomorrow");
    expect(dueWords(NOW - DAY, NOW)).toBe("Yesterday");
    expect(dueWords(null, NOW)).toBe("");
  });
});

describe("one course in numbers", () => {
  test("the grade over time steps through each graded item by due date", () => {
    const s = gradeSeries(algebra);
    expect(s.map((p) => p.title)).toEqual(["Set 1", "Set 2"]);
    expect(s[0]!.percent).toBeCloseTo(90);
    expect(s[1]!.percent).toBeCloseTo(75);
    expect(s[0]!.at).toBeLessThan(s[1]!.at);
  });

  test("a course with one graded item has no line", () => {
    expect(gradeSeries(art)).toHaveLength(1);
  });

  test("categories carry their weight and standing; empty ones still show their weight", () => {
    const c = categories(algebra);
    expect(c.map((x) => [x.name, x.weight])).toEqual([
      ["Sets", 40],
      ["Exams", 60],
    ]);
    expect(c[0]!.percent).toBeCloseTo(75);
    expect(c[1]!.percent).toBeNull();
  });

  test("without weights, a category's share is its points", () => {
    const c = categories(course("Points", [graded("A", 5, 10, { group: "Labs" }), item("B", { possible: 30, group: "Tests" })], { groups: [{ name: "Labs" }, { name: "Tests" }] }));
    expect(c.map((x) => [x.name, x.weight])).toEqual([
      ["Labs", 10],
      ["Tests", 30],
    ]);
  });

  test("stats count graded and open work and name the strongest category", () => {
    const s = courseStats(algebra, NOW);
    expect(s).toMatchObject({ graded: 2, total: 7, open: 5 });
    expect(s.dueThisWeek).toBe(1); // Set 3; the reading check is already handed in
    expect(s.best?.name).toBe("Sets");
    expect(s.worst).toBeNull();
  });
});
