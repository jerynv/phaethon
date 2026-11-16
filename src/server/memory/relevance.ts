import { awaitingOutcome, type MemoryItem } from "./items.ts";

/**
 * Which open memories a message makes relevant. No model call and no index:
 * the front burner is small, so every item is scored against the latest
 * message (and, at half weight, the one before it, so "ok, draft it" keeps
 * the topic). Signals:
 *
 * - words in common, weighted by how rare the word is among the items;
 * - a person the message names (by name or alias, "my boss") who is on the item;
 * - a time the message points at ("tonight", "Saturday", "this weekend")
 *   that the item falls in;
 * - availability and communication cues ("email", "late", "can I make it")
 *   raising what is current or near;
 * - outcome cues ("it went well", "I missed it") raising an event that has
 *   passed and is waiting to hear how it went.
 *
 * Small talk ("hi", "thanks") scores nothing at all.
 */

export type PersonRef = { id: string; names: string[] };
export type RelevanceInput = { text: string; recent?: string; now: number; people?: PersonRef[] };
export type Scored = { item: MemoryItem; score: number; reasons: string[] };

export const THRESHOLD = 2;
export const MAX_SELECTED = 6;

const STOP = new Set(
  (
    "a an the and or but if then so to of in on at by for with from up down out over under about into onto off as is am are was were be been being " +
    "i me my mine we us our you your yours he him his she her they them their it its this that these those there here what which who whom whose " +
    "do does did doing done have has had having will would shall should can could may might must just also very really too not no yes " +
    "how why when where all any some each every more most other such only own same than s t don now get got go going gonna wanna want need " +
    "please pls thanks thank ok okay hey hi hello yo sup lol haha hmm um uh oh well like know think make sure let lets one"
  ).split(" "),
);
const GREETING = /^(hi+|hey+|hello+|yo|sup|hiya|howdy|good (morning|afternoon|evening|night)|gm|thanks?( you)?|thx|ty|ok(ay)?|k|cool|nice|great|lol|haha+|test(ing)?|ping|what'?s up|how are you|how'?s it going)[\s!.?,]*$/i;

const set = (text: string) => new Set(text.trim().split(/\s+/));
const AVAILABILITY = set(
  "plan plans planning schedule scheduled calendar agenda free available availability busy late early tonight tomorrow weekend week morning afternoon evening " +
    "meeting meet appointment cancel reschedule postpone make attend skip miss sick ill unwell tired sleep alarm wake book booking trip travel flight today",
);
const COMMUNICATION = set("email emails mail message text tell inform notify call reply respond write draft send letter dm slack update");
const TASK_CUES = set("remind reminder owe owed due deadline todo pending follow overdue need forgot forget");
const STATE_END = set("better recovered back fine over ended finished returned healthy cleared");
const OUTCOME = set("went go goes attended attend missed miss happened over done finished cancelled canceled postponed rescheduled moved result outcome how great badly good fine");

/** Lowercased, accents folded, split on anything that isn't a letter or digit. */
export function words(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, "").replace(/'s$/, ""))
    .filter(Boolean);
}

/** A light stem so "meetings", "meeting" and "meet" can meet. */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function contentWords(text: string): string[] {
  return words(text).filter((w) => !STOP.has(w) && (w.length > 1 || /\d/.test(w)));
}

export function isSmallTalk(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (GREETING.test(t)) return true;
  return contentWords(t).length === 0;
}

// ---- Time cues -----------------------------------------------------------------

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_SHORT: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

type Window = { from: number; to: number; label: string };

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
const dayWindow = (start: number, label: string): Window => ({ from: start, to: addDays(start, 1) - 1, label });

/** The stretches of time a message points at, in local time. */
export function timeWindows(text: string, now: number): Window[] {
  const ws = words(text);
  const set = new Set(ws);
  const today = startOfDay(now);
  const out: Window[] = [];
  if (set.has("today") || set.has("tonight") || /\bthis (morning|afternoon|evening)\b/i.test(text)) out.push(dayWindow(today, "today"));
  if (set.has("tomorrow") || set.has("tmrw") || set.has("tmr")) out.push(dayWindow(addDays(today, 1), "tomorrow"));
  if (set.has("yesterday")) out.push(dayWindow(addDays(today, -1), "yesterday"));
  const dow = new Date(now).getDay();
  ws.forEach((w, i) => {
    const d = DAYS.indexOf(w) >= 0 ? DAYS.indexOf(w) : DAY_SHORT[w];
    if (d === undefined) return;
    const last = ws[i - 1] === "last";
    const ahead = (d - dow + 7) % 7;
    const start = last ? addDays(today, ahead === 0 ? -7 : ahead - 7) : addDays(today, ahead);
    out.push(dayWindow(start, w));
  });
  if (set.has("weekend")) {
    const ahead = dow === 0 ? -1 : (6 - dow + 7) % 7;
    const sat = addDays(today, ahead);
    out.push({ from: sat, to: addDays(sat, 2) - 1, label: "weekend" });
  }
  if (/\bthis week\b/i.test(text) || set.has("week")) out.push({ from: now - 3_600_000, to: addDays(today, 7 - dow + 1) - 1, label: "this week" });
  if (/\bnext week\b/i.test(text)) {
    const mon = addDays(today, ((8 - dow) % 7) || 7);
    out.push({ from: mon, to: addDays(mon, 7) - 1, label: "next week" });
  }
  if (/\b(right now|soon|later|in a bit|in an hour|this hour)\b/i.test(text)) out.push({ from: now - 3_600_000, to: now + 12 * 3_600_000, label: "soon" });
  // "Nov 22", "november 22nd", "22 nov", "11/22"
  const md = text.toLowerCase().matchAll(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b|\b(\d{1,2})\/(\d{1,2})\b/g);
  for (const m of md) {
    let month: number | undefined;
    let day: number | undefined;
    if (m[1] && m[2]) {
      month = MONTHS.indexOf(m[1].slice(0, 3));
      day = Number(m[2]);
    } else if (m[3] && m[4]) {
      month = MONTHS.indexOf(m[4].slice(0, 3));
      day = Number(m[3]);
    } else if (m[5] && m[6]) {
      month = Number(m[5]) - 1;
      day = Number(m[6]);
    }
    if (month === undefined || month < 0 || month > 11 || !day || day > 31) continue;
    const d = new Date(now);
    let at = new Date(d.getFullYear(), month, day).getTime();
    if (at < today - 60 * 86_400_000) at = new Date(d.getFullYear() + 1, month, day).getTime();
    out.push(dayWindow(at, `${MONTHS[month]} ${day}`));
  }
  return out;
}

// ---- Scoring -------------------------------------------------------------------

function itemWords(it: MemoryItem, people: PersonRef[]): string[] {
  const names = it.people.flatMap((id) => people.find((p) => p.id === id)?.names ?? []);
  return [...contentWords(`${it.text} ${it.why ?? ""} ${names.join(" ")}`), ...it.keywords.flatMap((k) => contentWords(k))].map(stem);
}

/** Person ids the message names, by any of their names or aliases (whole words, so "Dan" isn't "Danger"). */
export function peopleNamed(text: string, people: PersonRef[]): string[] {
  const t = ` ${words(text).join(" ")} `;
  const out: string[] = [];
  for (const p of people) {
    for (const n of p.names) {
      const w = words(n).filter((x) => x !== "my");
      if (!w.length) continue;
      if (t.includes(` ${w.join(" ")} `)) {
        out.push(p.id);
        break;
      }
    }
  }
  return out;
}

export function scoreItems(items: MemoryItem[], input: RelevanceInput): Scored[] {
  const active = items.filter((it) => it.status === "active");
  if (!active.length || isSmallTalk(input.text)) return [];
  const people = input.people ?? [];
  const docs = active.map((it) => new Set(itemWords(it, people)));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log(1 + (active.length + 1) / (df.get(w) ?? 0.5));

  const now = input.now;
  const main = new Set(contentWords(input.text).map(stem));
  const before = new Set(contentWords(input.recent ?? "").map(stem));
  const all = new Set([...words(input.text), ...words(input.recent ?? "")]);
  const windows = [...timeWindows(input.text, now), ...timeWindows(input.recent ?? "", now)];
  const named = new Set([...peopleNamed(input.text, people), ...peopleNamed(input.recent ?? "", people)]);
  const availability = [...all].some((w) => AVAILABILITY.has(w)) || /\bcan'?t make\b|\brunning late\b|\bon my way\b/i.test(input.text);
  const communication = [...all].some((w) => COMMUNICATION.has(w));
  const taskCue = [...all].some((w) => TASK_CUES.has(w));
  const outcome = [...words(input.text)].some((w) => OUTCOME.has(w));
  const stateEnd = [...words(input.text)].some((w) => STATE_END.has(w));

  const out: Scored[] = [];
  active.forEach((it, i) => {
    const doc = docs[i]!;
    const reasons: string[] = [];
    let score = 0;
    let lexical = 0;
    for (const w of main) if (doc.has(w)) lexical += idf(w);
    for (const w of before) if (doc.has(w) && !main.has(w)) lexical += idf(w) / 2;
    if (lexical) {
      score += Math.min(lexical, 6);
      reasons.push("words in common");
    }
    if (it.people.some((p) => named.has(p))) {
      score += 3;
      reasons.push("names a person on it");
    }
    const at = it.when;
    const span = it.kind === "state" || it.kind === "note" ? { from: it.created, to: it.until ?? it.created + 86_400_000 } : undefined;
    for (const w of windows) {
      if (at !== undefined && at >= w.from && at <= w.to) {
        score += 3;
        reasons.push(`happens ${w.label}`);
        break;
      }
      if (span && span.from <= w.to && span.to >= w.from) {
        score += 1.5;
        reasons.push(`holds ${w.label}`);
        break;
      }
    }
    const current = it.kind === "state" && (it.until === undefined || it.until > now);
    const near = at !== undefined && at > now - 3_600_000 && at < now + 48 * 3_600_000;
    const soon = at !== undefined && at > now - 3_600_000 && at < now + 24 * 3_600_000;
    // A state that holds right now matters to anything about time or getting in touch; that is what it's for.
    if (current && (availability || communication)) {
      score += 2;
      reasons.push(communication ? "holds now, and the message is about getting in touch" : "holds now, and the message is about time or availability");
    } else if (availability && near && it.kind !== "note") {
      score += soon && it.kind === "event" ? 2 : 1.5;
      reasons.push("coming up, and the message is about time or availability");
    }
    if (it.kind === "task" && (taskCue || communication)) {
      score += 1;
      reasons.push("open, and the message is about what's owed or getting in touch");
    }
    if (current && stateEnd) {
      score += 2;
      reasons.push("holds now, and the message may say it's over");
    }
    if (outcome && awaitingOutcome(it, now)) {
      score += lexical || windows.length ? 2 : 1;
      reasons.push("has passed and may be what the message is about");
    }
    if (score > 0) out.push({ item: it, score, reasons });
  });
  return out.sort((a, b) => b.score - a.score);
}

export function selectRelevant(items: MemoryItem[], input: RelevanceInput, max = MAX_SELECTED): Scored[] {
  return scoreItems(items, input)
    .filter((s) => s.score >= THRESHOLD)
    .slice(0, max);
}
