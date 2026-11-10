import { parseTime } from "./lms.ts";
import { isAlnum } from "./text.ts";

/**
 * Confidence-based repetition with SM-2-like intervals (port of
 * `study/schedule.rs`). All times are ms since the epoch and always passed in.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const EASE_START = 2.5;
export const EASE_MIN = 1.3;
export const EASE_MAX = 3.2;
export const INTERVAL_MAX_DAYS = 365.0;
export const HISTORY = 8;
export const MASTERY_WINDOW = 30 * DAY;
export const EXAM_MARGIN = 12 * HOUR;
export const EXAM_FLOOR = 30 * MINUTE;

/** One card's scheduling state (field order matches the Rust struct). */
export type CardState = {
  reps: number;
  lapses: number;
  ease: number;
  interval: number;
  due: number;
  last: number;
  history: number[];
};

/** `.phaethon/study/progress.json`. `days` is kept sorted and unique. */
export type Progress = {
  version: number;
  decks: Record<string, Record<string, CardState>>;
  days: number[];
};

export const lastConfidence = (s: CardState): number | undefined => s.history[s.history.length - 1];

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** The new state after a rating and whether the card comes back this session. */
export function rate(prev: CardState | undefined | null, confidence: number, now: number, exam?: number | null): [CardState, boolean] {
  const c = clamp(Math.trunc(confidence), 1, 5);
  const s: CardState = prev
    ? { ...prev, history: [...prev.history] }
    : { reps: 0, lapses: 0, ease: EASE_START, interval: 0.0, due: now, last: now, history: [] };
  const prevInterval = s.interval;
  let intervalDays: number;
  let wait: number;
  if (c === 1) {
    if (s.reps > 0 || prevInterval >= 1.0) s.lapses += 1;
    s.reps = 0;
    s.ease -= 0.2;
    intervalDays = 0.0;
    wait = 10 * MINUTE;
  } else if (c === 2) {
    s.reps = 0;
    s.ease -= 0.15;
    intervalDays = 1.0;
    wait = 0;
  } else {
    s.reps += 1;
    const [first, second, factor, step] = c === 3 ? [1.0, 3.0, 0.85, -0.05] : c === 4 ? [3.0, 7.0, 1.0, 0.0] : [5.0, 12.0, 1.3, 0.1];
    s.ease += step;
    let next = s.reps === 1 ? first : s.reps === 2 ? second : Math.max(prevInterval, first) * clamp(s.ease, EASE_MIN, EASE_MAX) * factor;
    if (c >= 4) next = Math.max(next, prevInterval + 1.0);
    intervalDays = Math.min(next, INTERVAL_MAX_DAYS);
    wait = 0;
  }
  s.ease = clamp(s.ease, EASE_MIN, EASE_MAX);
  s.interval = intervalDays;
  let due = now + (wait > 0 ? wait : Math.trunc(intervalDays * DAY));
  if (exam !== undefined && exam !== null && exam > now) {
    const latest = Math.max(exam - EXAM_MARGIN, 0);
    if (due > latest) due = now + Math.max(Math.floor(Math.max(latest - now, 0) / 2), EXAM_FLOOR);
  }
  s.due = due;
  s.last = now;
  s.history.push(c);
  if (s.history.length > HISTORY) s.history.shift();
  return [s, c <= 2];
}

/** Share of `ids` last rated 4 or 5 within the last 30 days. */
export function mastery(states: Record<string, CardState> | undefined | null, ids: readonly string[], now: number): number {
  if (!ids.length || !states) return 0;
  let known = 0;
  for (const id of ids) {
    const s = Object.hasOwn(states, id) ? states[id] : undefined;
    if (!s) continue;
    const c = lastConfidence(s);
    if (c !== undefined && c >= 4 && Math.max(now - s.last, 0) <= MASTERY_WINDOW) known++;
  }
  return known / ids.length;
}

/** Days in a row ending today (or yesterday when nothing's been studied yet today). */
export function streak(days: Iterable<number>, today: number): number {
  const set = new Set(days);
  let day = set.has(today) ? today : today - 1;
  let n = 0;
  while (set.has(day)) {
    n++;
    day--;
  }
  return n;
}

/** Seconds east of UTC for this computer's time zone at `ms` (every platform; Rust used 0 off unix). */
export function offsetSecs(ms: number): number {
  const v = -new Date(ms).getTimezoneOffset() * 60;
  return v === 0 ? 0 : v;
}

/** The local day `ms` falls on, as days since 1970-01-01. */
export function localDay(ms: number, offset: number): number {
  return Math.floor((Math.trunc(ms / 1000) + offset) / 86_400);
}

/** An exam from `study/exams.json`. */
export type Exam = { course?: string; title: string; date: string };

/** Start of an exam in ms: a date alone is local midnight; a time without a zone is local too. */
export function examStart(date: string, offset: number): number | null {
  const d = date.trim();
  const bytes = Buffer.from(d, "utf8");
  let tail = "";
  if (bytes.length > 11 && (bytes[11]! & 0xc0) !== 0x80) tail = bytes.subarray(11).toString("utf8");
  const hasZone = tail.endsWith("Z") || tail.endsWith("z") || tail.includes("+") || tail.includes("-");
  const secs0 = parseTime(d);
  if (secs0 === null) return null;
  const secs = hasZone ? secs0 : secs0 - offset;
  return secs < 0 ? null : secs * 1000;
}

function squash(s: string): string {
  let out = "";
  for (const c of s) if (isAlnum(c)) out += c.toLowerCase();
  return out;
}

/** Whether an exam's course names the deck's course (short code or folder name). */
export function sameCourse(examCourse: string, deckCourse: string): boolean {
  const a = squash(examCourse);
  const b = squash(deckCourse);
  return a !== "" && b !== "" && (a.includes(b) || b.includes(a));
}

/** The next exam for a deck of `course`: one naming that course, or one naming none. */
export function nextExam(exams: readonly Exam[], course: string | null | undefined, now: number, offset: number): number | null {
  let best: number | null = null;
  for (const e of exams) {
    const ec = e.course !== undefined && e.course.trim() !== "" ? e.course : null;
    const applies = ec === null ? true : course !== null && course !== undefined ? sameCourse(ec, course) : false;
    if (!applies) continue;
    const t = examStart(e.date, offset);
    if (t !== null && t > now && (best === null || t < best)) best = t;
  }
  return best;
}
