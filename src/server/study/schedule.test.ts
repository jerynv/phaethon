import { describe, expect, it } from "vitest";
import {
  DAY,
  EASE_MIN,
  EASE_START,
  EXAM_FLOOR,
  EXAM_MARGIN,
  HISTORY,
  HOUR,
  INTERVAL_MAX_DAYS,
  MINUTE,
  examStart,
  localDay,
  mastery,
  nextExam,
  rate,
  sameCourse,
  streak,
  type CardState,
  type Exam,
} from "./schedule.ts";

const T0 = 1_791_000_000_000;

function run(ratings: number[], exam: number | null = null): [CardState, boolean][] {
  const out: [CardState, boolean][] = [];
  let now = T0;
  for (const r of ratings) {
    const prev = out.length ? out[out.length - 1]![0] : undefined;
    if (prev) now = prev.due;
    out.push(rate(prev, r, now, exam));
  }
  return out;
}

describe("schedule", () => {
  it("matches the Rust IEEE vectors", () => {
    const iv = (v: [CardState, boolean][]) => v.map(([s]) => s.interval);
    const ease = (v: [CardState, boolean][]) => v.map(([s]) => s.ease);
    expect(iv(run([5, 5, 5, 5]))).toEqual([5, 12, 43.68000000000001, 164.67360000000005]);
    expect(ease(run([5, 5, 5, 5]))).toEqual([2.6, 2.7, 2.8000000000000003, 2.9000000000000004]);
    expect(iv(run([4, 4, 4, 4]))).toEqual([3, 7, 17.5, 43.75]);
    expect(ease(run([4, 4, 4, 4]))).toEqual([2.5, 2.5, 2.5, 2.5]);
    expect(iv(run([3, 3, 3, 3]))).toEqual([1, 3, 5.9925000000000015, 11.715337500000006]);
    expect(ease(run([3, 3, 3, 3]))).toEqual([2.45, 2.4000000000000004, 2.3500000000000005, 2.3000000000000007]);
    expect(rate(null, 5, T0).at(0)).toMatchObject({ due: T0 + 5 * DAY });
  });

  it("low ratings come back this session and soon", () => {
    let [s, again] = rate(null, 1, T0);
    expect(again).toBe(true);
    expect(s.due).toBe(T0 + 10 * MINUTE);
    [s, again] = rate(null, 2, T0);
    expect(again).toBe(true);
    expect(s.due).toBe(T0 + DAY);
    for (const c of [3, 4, 5]) expect(rate(null, c, T0)[1]).toBe(false);
  });

  it("intervals grow with confidence and history", () => {
    const days = (v: [CardState, boolean][]) => v.map(([s]) => s.interval);
    const f5 = days(run([5, 5, 5, 5]));
    const f4 = days(run([4, 4, 4, 4]));
    const f3 = days(run([3, 3, 3, 3]));
    for (const v of [f5, f4, f3]) for (let i = 1; i < v.length; i++) expect(v[i]!).toBeGreaterThan(v[i - 1]!);
    for (let i = 0; i < 4; i++) {
      expect(f5[i]!).toBeGreaterThan(f4[i]!);
      expect(f4[i]!).toBeGreaterThan(f3[i]!);
    }
    expect([f4[0], f4[1]]).toEqual([3, 7]);
    expect(run([5, 5, 5, 5]).at(-1)![0].ease).toBeGreaterThan(EASE_START);
    expect(run([3, 3, 3, 3]).at(-1)![0].ease).toBeLessThan(EASE_START);
    expect(run(Array(20).fill(5)).at(-1)![0].interval).toBeLessThanOrEqual(INTERVAL_MAX_DAYS);
  });

  it("forgetting resets and counts a lapse", () => {
    const v = run([4, 4, 4, 1]);
    const [s, again] = v[3]!;
    expect(again).toBe(true);
    expect([s.reps, s.lapses, s.interval]).toEqual([0, 1, 0]);
    expect(s.ease).toBeLessThan(EASE_START);
    expect(rate(s, 4, s.due)[0].interval).toBe(3);
    expect(rate(null, 1, T0)[0].lapses).toBe(0);
    const low = run(Array(30).fill(1)).at(-1)![0];
    expect(Math.abs(low.ease - EASE_MIN)).toBeLessThan(1e-9);
    expect(low.ease).toBe(1.3);
    expect(low.history.length).toBe(HISTORY);
  });

  it("an exam caps every interval before it", () => {
    const exam = T0 + 5 * DAY;
    for (const [s] of run([5, 5, 5, 5, 5, 5], exam)) {
      expect(s.due <= exam - EXAM_MARGIN || s.due - s.last === EXAM_FLOOR).toBe(true);
      expect(s.due).toBeLessThan(exam);
    }
    expect(run([5, 5])[1]![0].interval).toBe(12);
    expect(rate(null, 5, exam + DAY, exam)[0].due).toBe(exam + DAY + 5 * DAY);
    expect(rate(null, 5, T0, T0 + 3 * HOUR)[0].due).toBe(T0 + EXAM_FLOOR);
  });

  it("mastery counts recent fours and fives", () => {
    const ids = ["a", "b", "c", "d"];
    const m = { a: rate(null, 5, T0)[0], b: rate(null, 4, T0)[0], c: rate(null, 2, T0)[0] };
    expect(mastery(m, ids, T0)).toBe(0.5);
    expect(mastery(m, ids, T0 + 31 * DAY)).toBe(0);
    expect(mastery(null, ids, T0)).toBe(0);
    expect(mastery(m, [], T0)).toBe(0);
  });

  it("streaks", () => {
    const days = [10, 11, 12, 14];
    expect(streak(days, 14)).toBe(1);
    expect(streak(days, 13)).toBe(3);
    expect(streak(days, 12)).toBe(3);
    expect(streak(days, 16)).toBe(0);
    expect(localDay(DAY * 3 + 1, 0)).toBe(3);
    expect(localDay(DAY * 3 + 1, -3600)).toBe(2);
  });

  it("exams match their course and dates are local", () => {
    const exams: Exam[] = [
      { course: "CSCI-C 241", title: "Test 1", date: "2026-10-15" },
      { course: "MATH-M 301", title: "Exam", date: "2026-10-21T14:00" },
      { title: "Finals", date: "2026-12-14" },
      { title: "bad", date: "soon" },
    ];
    const off = -4 * 3600;
    const now = examStart("2026-10-10T12:00:00Z", 0)!;
    const c241 = nextExam(exams, "CSCI-C 241 Fall 2026 (All Sections)", now, off)!;
    expect(c241).toBe(examStart("2026-10-15T04:00:00Z", 0));
    expect(nextExam(exams, "FA26- LINEAR ALGEBRA & APPLICATIONS- 11179", now, off)).toBe(examStart("2026-12-14T04:00:00Z", 0));
    expect(nextExam(exams, null, now, off)).toBe(examStart("2026-12-14T04:00:00Z", 0));
    expect(nextExam(exams, "MATH-M 301", now, off)).toBe(examStart("2026-10-21T18:00:00Z", 0));
    expect(examStart("2026-10-21T14:00:00-04:00", 99)).toBe(examStart("2026-10-21T18:00:00Z", 0));
    expect(nextExam(exams.slice(0, 1), "CSCI-C 241", c241 + 1, off)).toBeNull();
    expect(sameCourse("", "x")).toBe(false);
    expect(sameCourse("csci c241", "CSCI-C 241 Fall")).toBe(true);
  });
});
