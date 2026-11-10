import fs from "node:fs";
import path from "node:path";
import { upcoming as dueAhead } from "../study/lms.ts";
import { writeIn } from "../study/files.ts";
import { charLen, cmpBytes, isControl, isWs } from "../study/text.ts";
import { can, seesDue, type Visible } from "../study/visible.ts";

/**
 * The study planner's files in a space (port of `plan.rs`): what's coming up
 * (due dates the course import keeps), the exams the person adds
 * (`study/exams.json`), the schedule written out as `study/plan.md`, and the
 * planner's own state in `.phaethon/study/plan.json`. The renderer never names
 * a path: each command knows its one file.
 */

export const EXAMS_FILE = "study/exams.json";
export const PLAN_FILE = "study/plan.md";
const STATE_FILE = ".phaethon/study/plan.json";

const MAX_READ = 1024 * 1024;
export const MAX_PLAN = 256 * 1024;
const MAX_EXAMS = 200;
const MAX_UPCOMING = 300;
const MAX_TITLE = 120;
const MAX_COURSE = 200;
const MAX_DONE = 2000;

export type Upcoming = { course: string; folder: string; title: string; due: number; link: string };
export type Exam = { id: string; course?: string; title: string; date: string };
export type PlanState = { studyDays: number[]; sessionsPerDay: number; sessionMinutes: number; done: string[] };
export type CourseRef = { name: string; folder: string };
export type UpcomingView = { courses: CourseRef[]; items: Upcoming[] };

export const defaultState = (): PlanState => ({ studyDays: [0, 1, 2, 3, 4, 5], sessionsPerDay: 3, sessionMinutes: 25, done: [] });

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The courses the space may see and everything due from now on (seconds) in them. */
export function upcoming(visible: Visible, nowSecs: number): UpcomingView {
  const items: Upcoming[] = [];
  const courses: CourseRef[] = [];
  for (const seen of visible.courses) {
    const c = seen.state;
    if (!courses.some((r) => r.folder === c.folder)) courses.push({ name: c.name, folder: c.folder });
    if (!seesDue(seen)) continue;
    for (const [t, d] of dueAhead(Array.isArray(c.due) ? c.due : [], nowSecs)) {
      const anchor = d.anchor ? `#${d.anchor}` : "";
      const link = can(seen, "assignments") ? `courses/${c.folder}/assignments.md${anchor}` : `courses/${c.folder}/README.md`;
      items.push({ course: c.name, folder: c.folder, title: d.title, due: t * 1000, link });
    }
  }
  items.sort((a, b) => a.due - b.due || cmpBytes(a.course, b.course) || cmpBytes(a.title, b.title));
  courses.sort((a, b) => cmpBytes(a.name, b.name));
  return { courses, items: items.slice(0, MAX_UPCOMING) };
}

// ---- Exams -------------------------------------------------------------------

/** An exam as JSON gave it (serde: id, title, date strings required; course optional string). */
function asExam(v: unknown): Exam | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.title !== "string" || typeof o.date !== "string") return null;
  if (o.course !== undefined && o.course !== null && typeof o.course !== "string") return null;
  const e: Exam = { id: o.id, title: o.title, date: o.date };
  if (typeof o.course === "string") e.course = o.course;
  return e;
}

const byDate = (a: Exam, b: Exam) => cmpBytes(a.date, b.date) || cmpBytes(a.title, b.title);

/**
 * The exams in `study/exams.json`, by date. An entry edited into something
 * that isn't an exam is left out. Both the array form and `{"exams": [...]}`
 * (which the card scheduler also reads) are accepted.
 */
export function examsGet(spaceDir: string): Exam[] {
  let text: string | null;
  try {
    text = readSmall(spaceDir, EXAMS_FILE);
  } catch (e) {
    throw `Your exams couldn’t be read: ${errText(e)}`;
  }
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw `Your exams file is damaged (${errText(e)}). Fix or remove study/exams.json.`;
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { exams?: unknown }).exams) ? (raw as { exams: unknown[] }).exams : null;
  if (!list) throw "Your exams file is damaged (it isn’t a list of exams). Fix or remove study/exams.json.";
  const exams: Exam[] = [];
  for (const v of list) {
    if (exams.length >= MAX_EXAMS) break;
    const e = asExam(v);
    if (!e) continue;
    try {
      exams.push(cleanExam(e));
    } catch {
      // a hand-edited entry that isn't an exam
    }
  }
  return exams.sort(byDate);
}

/** Replaces the exams, each checked; returns them as saved (trimmed, by date). */
export function examsSet(spaceDir: string, exams: Exam[]): Exam[] {
  if (exams.length > MAX_EXAMS) throw `A space can keep up to ${MAX_EXAMS} exams.`;
  const clean: Exam[] = [];
  for (const raw of exams) {
    const e = cleanExam(raw);
    if (clean.some((c) => c.id === e.id)) throw "Two exams have the same id.";
    clean.push(e);
  }
  clean.sort(byDate);
  try {
    writeIn(spaceDir, EXAMS_FILE, JSON.stringify(clean, null, 2) + "\n");
  } catch (e) {
    throw `Your exams couldn’t be saved: ${errText(e)}`;
  }
  return clean;
}

function cleanExam(e: Exam): Exam {
  const id = e.id.trim();
  if (!id || Buffer.byteLength(id) > 40 || !/^[A-Za-z0-9_-]+$/.test(id)) throw "That exam’s id isn’t one Phaethon made.";
  const title = oneLine(e.title);
  if (!title) throw "An exam needs a name, like “Test 1”.";
  if (charLen(title) > MAX_TITLE) throw `An exam’s name can be at most ${MAX_TITLE} characters.`;
  if (!validDate(e.date)) throw "An exam needs a real date.";
  let course: string | undefined;
  if (e.course !== undefined && e.course !== null) {
    const c = oneLine(e.course);
    if (c) {
      if (charLen(c) > MAX_COURSE || c.includes("/") || c.includes("\\") || c === "." || c === "..") throw "That course name can’t be used.";
      course = c;
    }
  }
  const date = e.date.trim();
  return course !== undefined ? { id, course, title, date } : { id, title, date };
}

/** Whitespace and control characters collapsed to single spaces. */
function oneLine(s: string): string {
  const words: string[] = [];
  let cur = "";
  for (const c of s) {
    if (isWs(c) || isControl(c)) {
      if (cur) words.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) words.push(cur);
  return words.join(" ");
}

/** `YYYY-MM-DD`, a real day in the years 2000 to 2100. */
export function validDate(raw: string): boolean {
  const s = raw.trim();
  if (Buffer.byteLength(s) !== 10 || s[4] !== "-" || s[7] !== "-") return false;
  const num = (a: number, b: number) => (/^[0-9]+$/.test(s.slice(a, b)) ? Number(s.slice(a, b)) : null);
  const y = num(0, 4);
  const m = num(5, 7);
  const d = num(8, 10);
  if (y === null || m === null || d === null) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [1, 3, 5, 7, 8, 10, 12].includes(m) ? 31 : [4, 6, 9, 11].includes(m) ? 30 : m === 2 ? (leap ? 29 : 28) : 0;
  if (!days) return false;
  return y >= 2000 && y <= 2100 && d >= 1 && d <= days;
}

// ---- The plan --------------------------------------------------------------

/** Writes the schedule (Markdown made by the planner) to `study/plan.md`. */
export function savePlan(spaceDir: string, markdown: string): string {
  if (Buffer.byteLength(markdown) > MAX_PLAN) throw "That plan is too long to save.";
  try {
    writeIn(spaceDir, PLAN_FILE, markdown);
  } catch (e) {
    throw `The plan couldn’t be saved: ${errText(e)}`;
  }
  return PLAN_FILE;
}

const isInt = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

/**
 * A plan state as JSON gave it, with serde's rules: studyDays (u8s),
 * sessionsPerDay (u8) and sessionMinutes (u16) required; done optional strings.
 * Throws a description of the first problem.
 */
export function asPlanState(v: unknown): PlanState {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw "invalid type: expected a plan state object";
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.studyDays) || !o.studyDays.every((d) => isInt(d, 255))) throw "studyDays must be a list of days of the week";
  if (!isInt(o.sessionsPerDay, 255)) throw "sessionsPerDay must be a small whole number";
  if (!isInt(o.sessionMinutes, 65535)) throw "sessionMinutes must be a whole number";
  if (o.done !== undefined && !(Array.isArray(o.done) && o.done.every((d) => typeof d === "string"))) throw "done must be a list of session ids";
  return { studyDays: [...o.studyDays], sessionsPerDay: o.sessionsPerDay, sessionMinutes: o.sessionMinutes, done: [...((o.done as string[] | undefined) ?? [])] };
}

export function stateGet(spaceDir: string): PlanState {
  try {
    const text = readSmall(spaceDir, STATE_FILE);
    if (text === null) return defaultState();
    return cleanState(asPlanState(JSON.parse(text)));
  } catch {
    return defaultState();
  }
}

export function stateSet(spaceDir: string, state: PlanState): PlanState {
  const clean = cleanState(state);
  try {
    writeIn(spaceDir, STATE_FILE, JSON.stringify(clean, null, 2));
  } catch (e) {
    throw `The plan couldn’t be saved: ${errText(e)}`;
  }
  return clean;
}

function cleanState(s: PlanState): PlanState {
  const studyDays = [...new Set(s.studyDays)].sort((a, b) => a - b);
  if (!studyDays.length || studyDays.some((d) => d > 6)) throw "Choose at least one day of the week to study on.";
  if (s.sessionsPerDay < 1 || s.sessionsPerDay > 8) throw "Plan between 1 and 8 sessions a day.";
  if (s.sessionMinutes < 10 || s.sessionMinutes > 120) throw "A session can be 10 to 120 minutes.";
  // Every repeat goes, not only neighbours (Rust's `dedup` kept non-adjacent ones).
  const done = [...new Set(s.done.filter((d) => d !== "" && Buffer.byteLength(d) <= 300))];
  return { studyDays, sessionsPerDay: s.sessionsPerDay, sessionMinutes: s.sessionMinutes, done: done.slice(Math.max(done.length - MAX_DONE, 0)) };
}

/** A small file at `rel` under `root`, `null` when missing; refuses a link anywhere on the way, non-files and big files. */
function readSmall(root: string, rel: string): string | null {
  let at = root;
  for (const part of rel.split("/")) {
    if (!part || part === "." || part === "..") throw new Error("not a plain path");
    at = path.join(at, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(at);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    if (st.isSymbolicLink()) throw new Error("it is a link");
  }
  const m = fs.lstatSync(at);
  if (!m.isFile() || m.size > MAX_READ) throw new Error("it isn’t a small plain file");
  const bytes = fs.readFileSync(at);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
