/**
 * The tests a course has for the make wizard's scope step, and what is known
 * of what each covers: found in the course's materials (with passages), said
 * by the person, looked for and not found, or not looked for yet.
 */
import type { ExamScope, ScopeView } from "./types";
import { examKey, plural, sameCourse, type CourseFolder } from "./words";

export type PlannedExam = { id: string; course?: string; title: string; date: string };

export type ExamOption = {
  title: string;
  date?: string;
  state: "known" | "stated" | "unknown" | "unchecked";
  scope?: ExamScope;
  stated?: string;
};

/** The choice that is a test not listed, named by the person. */
export const OTHER_EXAM = "\u0000other";

/** A known scope in a few words: "through HW 6; not graphs or combinatorics". */
export function scopeWords(e: Pick<ExamScope, "summary" | "includes" | "excludedWords">): string {
  let s = e.summary || plural(e.includes.length, "topic");
  if (e.excludedWords.length && !/\bnot /i.test(s)) s += `; not ${e.excludedWords.join(" or ")}`;
  return s;
}

/** A test's date in words ("Oct 15"), or nothing. Read as local noon so no timezone moves it a day. */
export function examDate(d?: string): string {
  const t = d && /^\d{4}-\d{2}-\d{2}/.test(d) ? new Date(`${d.slice(0, 10)}T12:00:00`).getTime() : NaN;
  return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A known scope's topics split into on the test and not on it. */
export function scopeTopics(view: ScopeView | null, scope: ExamScope): { on: string[]; off: string[] } {
  const on: string[] = [];
  const off: string[] = [];
  for (const t of view?.map?.topics ?? []) {
    if (!t.reference && scope.includes.includes(t.id) && !scope.excludes.includes(t.id)) on.push(t.title);
    else off.push(t.title);
  }
  return { on, off };
}

export function examOptions(course: CourseFolder, view: ScopeView | null, planned: readonly PlannedExam[]): ExamOption[] {
  const mapped = view?.map && view.state !== "none" ? view.map : null;
  const fresh = !!mapped && view?.state === "fresh";
  const said = (title: string) => view?.stated.find((x) => examKey(x.exam) === examKey(title))?.text;
  const out: ExamOption[] = [];
  const has = (title: string) => out.some((o) => examKey(o.title) === examKey(title));
  for (const e of mapped?.exams ?? []) {
    if (has(e.title)) continue;
    const stated = said(e.title);
    out.push({
      title: e.title,
      date: e.date,
      state: stated ? "stated" : e.known ? "known" : fresh ? "unknown" : "unchecked",
      scope: e.known ? e : undefined,
      stated,
    });
  }
  for (const x of view?.stated ?? []) if (!has(x.exam)) out.push({ title: x.exam, state: "stated", stated: x.text });
  for (const e of planned) {
    if (!e.title.trim() || has(e.title) || !sameCourse(e.course, course)) continue;
    out.push({ title: e.title, date: e.date, state: fresh ? "unknown" : "unchecked" });
  }
  return out
    .map((o, i) => ({ o, i }))
    // By date, the undated after.
    .sort((a, b) => (a.o.date === b.o.date ? 0 : !a.o.date ? 1 : !b.o.date ? -1 : a.o.date < b.o.date ? -1 : 1) || a.i - b.i)
    .map(({ o }) => o);
}
