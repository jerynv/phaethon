/**
 * Plan's day words: a calendar day relative to today ("Today", "Tomorrow",
 * "In 3 days", "Yesterday"), a short day label ("Thu 15 Oct"), and upcoming
 * deadlines and exams grouped by day. Days are local "YYYY-MM-DD". Pure.
 */
import { daysBetween, localDay, type Session, toMs } from "./schedule";

export function relDay(day: string, today: string): string {
  const n = daysBetween(today, day);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  if (n < 0) return `${-n} days ago`;
  if (n < 14) return `In ${n} days`;
  if (n < 60) return `In ${Math.round(n / 7)} weeks`;
  return `In ${Math.round(n / 30)} months`;
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 15 Oct". */
export function shortDay(day: string): string {
  const d = new Date(toMs(day));
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
}

export type AgendaItem =
  | { kind: "due"; day: string; title: string; course: string; at: number; link: string }
  | { kind: "exam"; day: string; title: string; course?: string; id: string };

/** Deadlines and exams from today on, by day, soonest first; within a day exams first, then by time. */
export function agenda(
  due: readonly { title: string; course: string; due: number; link: string }[],
  exams: readonly { id: string; title: string; course?: string; date: string }[],
  today: string,
  dayOf: (ms: number) => string = localDay,
): { day: string; items: AgendaItem[] }[] {
  const items: AgendaItem[] = [
    ...due.map((d) => ({ kind: "due" as const, day: dayOf(d.due), title: d.title, course: d.course, at: d.due, link: d.link })),
    ...exams.map((e) => ({ kind: "exam" as const, day: e.date, title: e.title, course: e.course, id: e.id })),
  ].filter((i) => i.day >= today);
  const byDay = new Map<string, AgendaItem[]>();
  for (const i of items) byDay.set(i.day, [...(byDay.get(i.day) ?? []), i]);
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, list]) => ({
      day,
      items: list.sort((a, b) => (a.kind !== b.kind ? (a.kind === "exam" ? -1 : 1) : a.kind === "due" && b.kind === "due" ? a.at - b.at : a.title.localeCompare(b.title))),
    }));
}

// ---- One agenda: deadlines, exams and study sessions by day ----

/** What a row of the agenda is; `session` rows can be checked off. */
export type Entry =
  | { key: string; kind: "due"; title: string; course: string; at: number; link: string }
  | { key: string; kind: "exam"; title: string; course?: string; id: string }
  | { key: string; kind: "session"; title: string; course?: string; session: Session };

export type Show = "all" | "due" | "exam" | "session";
export type Filter = { show: Show; course: string | null };

/**
 * Deadlines and exams (from `agenda`) and the schedule's sessions merged into
 * one list of days, soonest first; within a day exams, then deadlines by time,
 * then sessions in the schedule's order. The filter keeps one kind and/or one
 * course; days left empty by it are dropped.
 */
export function timeline(
  dueDays: readonly { day: string; items: AgendaItem[] }[],
  sessionDays: readonly { day: string; sessions: readonly Session[] }[],
  filter: Filter = { show: "all", course: null },
): { day: string; entries: Entry[] }[] {
  const byDay = new Map<string, Entry[]>();
  const add = (day: string, e: Entry) => byDay.set(day, [...(byDay.get(day) ?? []), e]);
  for (const g of dueDays)
    for (const i of g.items)
      add(g.day, i.kind === "exam" ? { key: `e${i.id}`, kind: "exam", title: i.title, course: i.course, id: i.id } : { key: `d${i.link}${i.at}`, kind: "due", title: i.title, course: i.course, at: i.at, link: i.link });
  for (const g of sessionDays) for (const s of g.sessions) add(g.day, { key: `s${s.id}`, kind: "session", title: s.title, course: s.course, session: s });
  const rank = { exam: 0, due: 1, session: 2 } as const;
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, entries]) => ({
      day,
      entries: entries
        .filter((e) => (filter.show === "all" || e.kind === filter.show) && (!filter.course || e.course === filter.course))
        .sort((a, b) => rank[a.kind] - rank[b.kind] || (a.kind === "due" && b.kind === "due" ? a.at - b.at : 0)),
    }))
    .filter((g) => g.entries.length);
}

/** How many of each kind, and per course, for the filter list. */
export function counts(days: readonly { day: string; entries: readonly Entry[] }[]): { all: number; due: number; exam: number; session: number; courses: Map<string, number> } {
  const out = { all: 0, due: 0, exam: 0, session: 0, courses: new Map<string, number>() };
  for (const g of days)
    for (const e of g.entries) {
      out.all++;
      out[e.kind]++;
      if (e.course) out.courses.set(e.course, (out.courses.get(e.course) ?? 0) + 1);
    }
  return out;
}
