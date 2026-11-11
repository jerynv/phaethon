/**
 * Grades' table: each course's items as the calculator's items (keyed by
 * title and which occurrence of it they are, as newly.ts matches them), each
 * item's share of the course grade, and the snapshot of what was last seen.
 * Pure (table.test.ts).
 */
import { type CalcItem, timeOf } from "./what-if";
import type { CourseGradeView, GradeItem } from "./types";

export const itemKey = (title: string, n: number) => `${title}\u0000${n}`;

/** The course's items with stable keys, in the site's order. */
export function keyedItems(items: readonly GradeItem[]): { key: string; item: GradeItem }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const n = seen.get(item.title) ?? 0;
    seen.set(item.title, n + 1);
    return { key: itemKey(item.title, n), item };
  });
}

export function calcItems(c: Pick<CourseGradeView, "items">): CalcItem[] {
  return keyedItems(c.items).map(({ key, item }) => ({
    key,
    title: item.title,
    group: item.group,
    score: item.score,
    possible: item.possible,
    percent: item.percent,
    graded: item.graded,
    excused: item.excused,
    due: timeOf(item.due),
  }));
}

/**
 * Each item's share of the course grade in percent, once everything is
 * graded: its group's weight split by points (or the item's points over all
 * points when the course has no weights). Excused and pointless items have
 * none (null).
 */
export function itemWeights(c: Pick<CourseGradeView, "items" | "groups">): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const keyed = keyedItems(c.items);
  const counts = (i: GradeItem) => !i.excused && (i.possible ?? 0) > 0;
  const usesWeights = c.groups.some((g) => (g.weight ?? 0) > 0);
  const names = new Set(c.groups.map((g) => g.name));
  if (usesWeights) {
    // Weights rescale over the groups that have items with points.
    const groupPoints = new Map<string, number>();
    for (const { item } of keyed) if (counts(item) && item.group && names.has(item.group)) groupPoints.set(item.group, (groupPoints.get(item.group) ?? 0) + item.possible!);
    const totalWeight = c.groups.reduce((s, g) => s + (groupPoints.get(g.name) ? (g.weight ?? 0) : 0), 0);
    for (const { key, item } of keyed) {
      const g = c.groups.find((x) => x.name === item.group);
      const pts = item.group ? groupPoints.get(item.group) : undefined;
      out.set(key, counts(item) && g?.weight && pts && totalWeight ? (g.weight / totalWeight) * (item.possible! / pts) * 100 : null);
    }
  } else {
    const total = keyed.reduce((s, { item }) => s + (counts(item) ? item.possible! : 0), 0);
    for (const { key, item } of keyed) out.set(key, counts(item) && total ? (item.possible! / total) * 100 : null);
  }
  return out;
}

/** A weight as the table shows it: "12.5%", "<0.1%". */
export function weightText(w: number | null | undefined): string {
  if (w == null) return "–";
  if (w > 0 && w < 0.1) return "<0.1%";
  const r = Math.round(w * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}%`;
}

// ---- What was seen last time, for "new since last look" ----

const seenKey = (space: string) => `phaethon.grades-seen:${space}`;

/** Only what newly.ts compares: the course and its items' titles and graded flags. */
export function snapshot(courses: readonly CourseGradeView[]): CourseGradeView[] {
  return courses.map((c) => ({
    ...c,
    groups: [],
    items: c.items.map((i) => ({ ...i, comments: [] })),
  }));
}

export function loadSeen(space: string): CourseGradeView[] | null {
  try {
    const raw = globalThis.localStorage?.getItem(seenKey(space));
    const v: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? (v as CourseGradeView[]) : null;
  } catch {
    return null;
  }
}

export function saveSeen(space: string, courses: readonly CourseGradeView[]): void {
  try {
    globalThis.localStorage?.setItem(seenKey(space), JSON.stringify(snapshot(courses)));
  } catch {
    // Storage full or blocked: everything simply reads as seen next time.
  }
}
