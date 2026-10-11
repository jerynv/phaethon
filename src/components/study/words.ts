
import { studySources, type Attempt, type Card, type StudyEvent } from "@/lib/study";

/** Confidence 1..5 in words, as the rating buttons say it. */
export const CONFIDENCE = ["Not at all", "Barely", "Somewhat", "Mostly", "Perfectly"] as const;
export const confidenceWord = (n: number) => CONFIDENCE[Math.min(5, Math.max(1, Math.round(n))) - 1];

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const percent = (x: number) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;

/** The last part of a path, without .md / .json: "study/decks/Graph theory.md" is "Graph theory". */
export function baseName(path: string): string {
  const last = path.split("/").filter(Boolean).pop() ?? path;
  return last.replace(/\.(md|json)$/i, "");
}

/** A day in words: "today", "tomorrow", "Oct 14". */
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

// ---- Cloze cards: the front holds its blank as {{answer}} ----

const CLOZE = /\{\{(.+?)\}\}/g;
export type Piece = { text: string; blank: boolean };

/** A cloze text split into plain text and blanks. */
export function clozePieces(text: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  for (const m of text.matchAll(CLOZE)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), blank: false });
    out.push({ text: m[1], blank: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), blank: false });
  return out;
}

/** The front of a card as words, with "blank" for each gap. */
export const spokenFront = (c: Pick<Card, "front">) => c.front.replace(CLOZE, "blank");
/** The back of a cloze card: its whole sentence, with what goes in the blank. */
export const clozeAnswer = (c: Pick<Card, "front">) => c.front.replace(CLOZE, "$1");

// ---- Streamed events, read defensively (only the fields each screen needs) ----

type Done = Extract<StudyEvent, { type: "done" }>;
export const doneField = <T,>(e: Done, key: string): T | undefined => (e as unknown as Record<string, T | undefined>)[key];
export const attemptOf = (e: Done) => doneField<Attempt>(e, "attempt");

/**
 * The model isn't set up (no API key, Claude Code not installed or not signed
 * in): the error says what to do, and the screen offers Settings.
 */
export const needsModel = (message: string) => /no model|api key|claude code|not logged in|sign(ed)? in to claude/i.test(message);

/** Make a raw core error readable: no "Error:" prefix, no trailing whitespace. */
export const plainError = (e: unknown) => String(e instanceof Error ? e.message : e).replace(/^error:\s*/i, "").trim();

// ---- Courses in the space (for choosing what to make cards from) ----

/** What an imported course folder holds that is worth making cards from (lms.md: the importer writes these). */
export const COURSE_PARTS = [
  { part: "syllabus.md", label: "Syllabus" },
  { part: "assignments.md", label: "Assignments" },
  { part: "files", label: "Course files" },
  { part: "readings", label: "Readings" },
] as const;

export type CourseFolder = { name: string; folder: string };

/**
 * The space's imported courses, by folder ("courses/<name>"), from the core
 * (study_sources), plus the courses decks and quizzes already name. Empty when
 * there are none or the core can't say.
 */
export async function courseFolders(space: string, alsoNamed: (string | undefined)[]): Promise<CourseFolder[]> {
  const found = new Map<string, CourseFolder>();
  try {
    for (const c of await studySources(space)) found.set(c.folder, { name: c.name, folder: c.folder });
  } catch {
    // The core couldn't list them: only the courses decks already name.
  }
  for (const name of alsoNamed) {
    if (!name) continue;
    const folder = `courses/${name}`;
    if (!found.has(folder)) found.set(folder, { name, folder });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
