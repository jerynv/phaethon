/**
 * Study's words and small helpers: confidence in words, durations, cloze
 * blanks, progress of a run in plain words, and how exam names compare.
 * Pure, so vitest runs them (words.test.ts).
 */
import type { Card, Evidence } from "./types";

export const CONFIDENCE = ["Not at all", "Barely", "Somewhat", "Mostly", "Perfectly"] as const;
export const confidenceWord = (n: number) => CONFIDENCE[Math.min(5, Math.max(1, Math.round(n))) - 1];

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const percent = (x: number) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;

/** The last part of a path, without .md / .json: "study/decks/Graph theory.md" is "Graph theory". */
export function baseName(path: string): string {
  const last = path.split("/").filter(Boolean).pop() ?? path;
  return last.replace(/\.(md|json)$/i, "");
}

/** A day in words: "today", "tomorrow", "Oct 14". A time already past reads "today". */
export function dayText(ms: number, now = Date.now()): string {
  const start = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const days = Math.round((start(ms) - start(now)) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function durationText(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return plural(mins, "minute");
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${plural(h, "hour")} ${plural(m, "minute")}` : plural(h, "hour");
}

/** Roughly how long a review of `cards` takes: about 20 seconds a card, never under a minute. */
export function reviewMinutes(cards: number): number {
  return Math.max(1, Math.round((cards * 20) / 60));
}

// ---- Cloze cards: the front holds its blank as {{answer}} ----

const CLOZE = /\{\{(.+?)\}\}/gs;
export type Piece = { text: string; blank: boolean };

/** Anki-style `c1::answer::hint` inside a blank reads as `answer`. */
const blankText = (inner: string) => inner.replace(/^[cC]\d+::/, "").split("::")[0]!.trim();

/** A cloze text split into plain text and blanks. */
export function clozePieces(text: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const m of text.matchAll(CLOZE)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), blank: false });
    out.push({ text: blankText(m[1]!), blank: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), blank: false });
  return out;
}

export const isCloze = (front: string) => /\{\{.+?\}\}/s.test(front);
/** The front of a card as words, with "blank" for each gap. */
export const spokenFront = (c: Pick<Card, "front">) => c.front.replace(CLOZE, "blank");
/** The back of a cloze card: its whole sentence, with what goes in the blank. */
export const clozeAnswer = (c: Pick<Card, "front">) => c.front.replace(CLOZE, (_, inner: string) => blankText(inner));

/** Where a card comes from, as a question's citations say it. */
export function cardCites(c: Pick<Card, "source" | "quote" | "picture">): Evidence[] {
  if (!c.source || !c.quote) return [];
  return [{ source: c.source, quote: c.quote, ...(c.picture ? { at: `p. ${c.picture}`, picture: c.picture } : {}) }];
}

/**
 * The model isn't set up (no API key, Claude Code not installed or not signed
 * in): the error says what to do, and the screen offers Settings.
 */
export const needsModel = (message: string) => /no model|api key|claude code|not logged in|sign(ed)? in to claude|in settings/i.test(message);

/** A raw core error made readable: no "Error:" prefix, no trailing whitespace. */
export const plainError = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^error:\s*/i, "").trim();

/** What an imported course folder holds that is worth making cards from. */
export const COURSE_PARTS = [
  { part: "syllabus.md", label: "Syllabus" },
  { part: "assignments.md", label: "Assignments" },
  { part: "files", label: "Course files" },
  { part: "readings", label: "Readings" },
] as const;

export type CourseFolder = { name: string; folder: string };

/** One step of making a quiz or cards, as the core streams it. */
export type MakeProgress = { step: string; done: number; total: number; kept?: number; dropped?: number };

/** Each step of making a quiz or cards in plain words, never a raw step code. */
export function progressWords(p: MakeProgress, o: { quiz: boolean; course?: string; exam?: string }): string {
  const noun = o.quiz ? "question" : "card";
  switch (p.step) {
    case "mapping":
      return `Reading ${o.course ?? "the course"} to see what it teaches and what ${o.exam ?? "each test"} covers${p.total > 1 ? ` (part ${Math.min(p.done + 1, p.total)} of ${p.total})` : ""}. The first time takes a few minutes…`;
    case "reading":
      return `Finding the passages that teach each topic${o.exam ? ` in ${o.exam}` : ""}…`;
    case "making":
      return p.done === 0 ? `Writing the ${noun}s from those passages…` : `Writing replacements for the ${noun}s that didn’t pass…`;
    case "checking":
      return `Checking each ${noun} against your notes${p.total ? ` (${Math.min(p.done, p.total)} of ${p.total})` : ""}: ${p.kept ?? 0} kept, ${p.dropped ?? 0} dropped so far…`;
    case "saving":
      return o.quiz ? "Saving the quiz…" : "Saving the cards…";
    case "grading":
      return "Checking your answers…";
    case "reviewing":
      return "Looking over your mistakes…";
    default:
      return "Getting started…";
  }
}

/** Two names of one test: "Exam 1" is "Test 1"; case, spaces and punctuation aside. */
export const examKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/\b(exam|quiz|examination)\b/g, "test")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** An exam named for `course` in study/exams.json: one naming no course is any course's. */
export function sameCourse(examCourse: string | undefined, course: CourseFolder): boolean {
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (!examCourse?.trim()) return true;
  const a = squash(examCourse);
  return [course.name, course.folder.replace(/^courses\//, "")].some((n) => {
    const b = squash(n);
    return !!a && !!b && (a.includes(b) || b.includes(a));
  });
}

/** A citation's source in words: "Lecture 4 §5.3", with a note when read from a picture of the page. */
export function sourceWords(e: Pick<Evidence, "source" | "at" | "picture">): string {
  const name = (e.source.replace(/\/+$/, "").split("/").pop() || e.source).replace(/\.(pdf|md|docx|pptx|txt)$/i, "");
  return `${name}${e.at ? ` ${e.at}` : ""}${e.picture ? " (read from a picture of the page)" : ""}`;
}

/** The page a citation points at: its picture's page, or an `at` like "p. 4". */
export function evidencePage(e: Pick<Evidence, "at" | "picture">): number | undefined {
  if (e.picture) return e.picture;
  const m = e.at ? /^p\.\s*(\d+)$/.exec(e.at) : null;
  return m ? Number(m[1]) : undefined;
}
