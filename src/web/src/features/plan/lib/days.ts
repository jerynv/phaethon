/**
 * Plan's day words: a calendar day relative to today ("Today", "Tomorrow",
 * "In 3 days", "Yesterday"), a short day label ("Thu 15 Oct"), and upcoming
 * deadlines and exams grouped by day. Days are local "YYYY-MM-DD". Pure.
 */
import { daysBetween, localDay, toMs } from "./schedule";

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
