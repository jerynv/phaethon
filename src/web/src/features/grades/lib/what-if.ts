/**
 * The grade calculator behind Grades' "What if": a course grade from its
 * items and group weights, with scores the person tries out for what isn't
 * graded yet, and the score needed on one item (or a final exam) to reach a
 * grade. Pure (what-if.test.ts).
 *
 * How it counts (as Canvas and most course sites do by default): an excused
 * item never counts; an ungraded one counts only once it has a score here.
 * Each group's percent is its points earned over its points possible; with
 * weights, the course grade is the weighted mean of the groups that have
 * anything counted (weights rescaled over those); without, it is total
 * points. Drop-lowest rules and extra credit outside the items aren't known.
 */

export type CalcItem = {
  key: string;
  title: string;
  group?: string;
  score?: number;
  possible?: number;
  percent?: number;
  graded: boolean;
  excused: boolean;
  /** When it was due, ms since the epoch (for the trend). */
  due?: number | null;
};

export type CalcGroup = { name: string; weight?: number };

/** A final exam not in the course's items: worth `weight` percent of the course. */
export type FinalExam = { weight: number; percent: number | null };

export type CalcInput = {
  groups: readonly CalcGroup[];
  items: readonly CalcItem[];
  /** Item key → a score to try, in percent of the item. */
  tryScores?: Readonly<Record<string, number>>;
  final?: FinalExam | null;
};

export type GroupResult = { name: string; weight?: number; percent: number | null; counted: number };

export type CalcResult = {
  /** The course grade in percent, or null when nothing counts yet. */
  percent: number | null;
  groups: GroupResult[];
  usesWeights: boolean;
};

const OTHER = "Other";

/** An item's points (earned, possible) with a tried score, or null when it doesn't count. */
function points(item: CalcItem, tried: number | undefined): [number, number] | null {
  if (item.excused) return null;
  const possible = item.possible != null && item.possible > 0 ? item.possible : null;
  if (tried != null && Number.isFinite(tried)) return possible ? [(tried / 100) * possible, possible] : [tried, 100];
  if (!item.graded) return null;
  if (possible && item.score != null) return [item.score, possible];
  if (item.percent != null) return possible ? [(item.percent / 100) * possible, possible] : [item.percent, 100];
  // Graded, worth no points (extra credit, or a 0-point check-in): its score adds to its group.
  if (item.score != null && item.possible === 0) return [item.score, 0];
  return null;
}

export function calculate(input: CalcInput): CalcResult {
  const usesWeights = input.groups.some((g) => (g.weight ?? 0) > 0);
  const byGroup = new Map<string, { earned: number; possible: number; counted: number }>();
  const names = input.groups.map((g) => g.name);
  for (const item of input.items) {
    const p = points(item, input.tryScores?.[item.key]);
    if (!p) continue;
    const name = item.group && names.includes(item.group) ? item.group : OTHER;
    const g = byGroup.get(name) ?? { earned: 0, possible: 0, counted: 0 };
    g.earned += p[0];
    g.possible += p[1];
    g.counted++;
    byGroup.set(name, g);
  }
  const groups: GroupResult[] = [...input.groups.map((g) => ({ ...g })), ...(byGroup.has(OTHER) && !names.includes(OTHER) ? [{ name: OTHER }] : [])].map(
    (g) => {
      const t = byGroup.get(g.name);
      return { name: g.name, weight: g.weight, counted: t?.counted ?? 0, percent: t && t.possible > 0 ? (t.earned / t.possible) * 100 : null };
    },
  );
  let percent: number | null = null;
  if (usesWeights) {
    let sum = 0;
    let weights = 0;
    for (const g of groups) {
      if ((g.weight ?? 0) > 0 && g.percent != null) {
        sum += g.weight! * g.percent;
        weights += g.weight!;
      }
    }
    percent = weights > 0 ? sum / weights : null;
  } else {
    let earned = 0;
    let possible = 0;
    for (const t of byGroup.values()) {
      earned += t.earned;
      possible += t.possible;
    }
    percent = possible > 0 ? (earned / possible) * 100 : null;
  }
  const f = input.final;
  if (f && f.weight > 0 && f.weight <= 100 && f.percent != null && Number.isFinite(f.percent)) {
    const w = f.weight / 100;
    percent = percent == null ? f.percent : percent * (1 - w) + f.percent * w;
  }
  return { percent, groups, usesWeights };
}

/** What to solve for: one item's score, or the final exam's. */
export type SolveFor = { item: string } | { final: true };

export type Needed =
  | { kind: "needs"; percent: number }
  /** Even 0% there reaches the target. */
  | { kind: "already" }
  /** Even 100% there falls short; `best` is the grade 100% gives. */
  | { kind: "out-of-reach"; best: number }
  /** Nothing counts yet, or there is no final to solve for. */
  | { kind: "unknown" };

/** The lowest score (in percent, to 0.1) on `solve` that brings the course to `target` percent. */
export function needed(input: CalcInput, solve: SolveFor, target: number): Needed {
  const at = (p: number): number | null => {
    if ("item" in solve) return calculate({ ...input, tryScores: { ...input.tryScores, [solve.item]: p } }).percent;
    if (!input.final || input.final.weight <= 0) return null;
    return calculate({ ...input, final: { ...input.final, percent: p } }).percent;
  };
  const low = at(0);
  const high = at(100);
  if (low == null || high == null) return { kind: "unknown" };
  // A hair under the target still rounds to it as sites show grades (to 2 places).
  const reaches = (g: number) => g >= target - 0.005;
  if (reaches(low)) return { kind: "already" };
  if (!reaches(high)) return { kind: "out-of-reach", best: high };
  let lo = 0;
  let hi = 100;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (reaches(at(mid)!)) hi = mid;
    else lo = mid;
  }
  return { kind: "needs", percent: Math.ceil(hi * 10 - 1e-9) / 10 };
}

/**
 * How the grade moved with the latest graded item (by due date): the course
 * grade with every graded item, minus the grade without that one. Null when
 * there aren't two graded items to compare.
 */
export function trend(input: CalcInput): { delta: number; since: string } | null {
  const graded = input.items.filter((i) => i.graded && !i.excused && i.due != null).sort((a, b) => a.due! - b.due!);
  if (graded.length < 2) return null;
  const last = graded[graded.length - 1];
  const base = { groups: input.groups, items: input.items };
  const now = calculate(base).percent;
  const before = calculate({ ...base, items: input.items.filter((i) => i !== last) }).percent;
  if (now == null || before == null) return null;
  return { delta: now - before, since: last.title };
}

/** A common US scale (the course's own may differ). */
export const LETTERS: readonly [string, number][] = [
  ["A", 93],
  ["A-", 90],
  ["B+", 87],
  ["B", 83],
  ["B-", 80],
  ["C+", 77],
  ["C", 73],
  ["C-", 70],
  ["D+", 67],
  ["D", 63],
  ["D-", 60],
  ["F", 0],
];

export function letterFor(percent: number): string {
  return LETTERS.find(([, min]) => percent >= min - 0.005)?.[0] ?? "F";
}

/** "87.4%": one decimal, none when whole. */
export function pct(n: number): string {
  const r = Math.round(n * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}%`;
}

// ---- The What-if panel's arithmetic: what the person typed, read and solved ----

/** What the person typed in the panel, per course (strings, as typed). */
export type Tried = { scores: Record<string, string>; finalWeight: string; finalScore: string; target: string; on: string };

/** The "on" choice that is a final exam the course doesn't list. */
export const FINAL = "__final__";

/** A typed number: commas read as decimal points; empty is null; anything else unreadable is NaN. */
export function parseTyped(s: string): number | null {
  const t = s.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

/** The items still open (not graded, not excused), and which to solve for by default: the last named "final", else the first. */
export function openItems(input: CalcInput): CalcItem[] {
  return input.items.filter((i) => !i.graded && !i.excused);
}

export function defaultOn(input: CalcInput): string {
  const open = openItems(input);
  return [...open].reverse().find((i) => /final/i.test(i.title))?.key ?? open[0]?.key ?? FINAL;
}

export type WhatIfResult = {
  /** Item keys whose typed score is out of range or unreadable. */
  bad: string[];
  finalBad: { weight: boolean; score: boolean };
  tryScores: Record<string, number>;
  final: FinalExam | null;
  now: number | null;
  projected: number | null;
  /** Anything typed that changes the grade. */
  changed: boolean;
  targetPercent: number;
  need: Needed;
};

/**
 * The panel's numbers from what was typed. A score is in points when the item
 * has points (else percent), from 0 to twice the points (extra credit). The
 * final's weight is a share of the course strictly between 0 and 100, its
 * score 0–200%.
 */
export function whatIf(input: CalcInput, t: Tried): WhatIfResult {
  const open = openItems(input);
  const tryScores: Record<string, number> = {};
  const bad: string[] = [];
  for (const i of open) {
    const v = parseTyped(t.scores[i.key] ?? "");
    if (v == null) continue;
    const max = i.possible ? i.possible * 2 : 200;
    if (Number.isNaN(v) || v < 0 || v > max) bad.push(i.key);
    else tryScores[i.key] = i.possible ? (v / i.possible) * 100 : v;
  }
  const fw = parseTyped(t.finalWeight);
  const fs = parseTyped(t.finalScore);
  const finalBad = {
    weight: fw != null && (Number.isNaN(fw) || fw <= 0 || fw >= 100),
    score: fs != null && (Number.isNaN(fs) || fs < 0 || fs > 200),
  };
  const final = fw != null && !finalBad.weight ? { weight: fw, percent: fs != null && !finalBad.score ? fs : null } : null;
  const now = calculate(input).percent;
  const projected = calculate({ ...input, tryScores, final }).percent;
  const changed = Object.keys(tryScores).length > 0 || final?.percent != null;
  const targetPercent = LETTERS.find(([l]) => l === t.target)?.[1] ?? Number(t.target);
  const onFinal = t.on === FINAL;
  const others = { ...tryScores };
  if (!onFinal) delete others[t.on];
  const need: Needed =
    (onFinal && !final) || (!onFinal && !open.some((i) => i.key === t.on))
      ? { kind: "unknown" }
      : needed({ ...input, tryScores: others, final }, onFinal ? { final: true } : { item: t.on }, targetPercent);
  return { bad, finalBad, tryScores, final, now, projected, changed, targetPercent, need };
}

/** The answer to "What do I need?" in a sentence. */
export function needText(input: CalcInput, t: Tried, r: Pick<WhatIfResult, "need" | "targetPercent">): string {
  const onFinal = t.on === FINAL;
  const item = openItems(input).find((i) => i.key === t.on);
  const onName = onFinal ? "the final exam" : (item?.title ?? "it");
  const goal = `${t.target} (${r.targetPercent}%)`;
  const need = r.need;
  switch (need.kind) {
    case "needs": {
      const points = item?.possible ? ` (${Math.round((need.percent / 100) * item.possible * 10) / 10} out of ${item.possible})` : "";
      return `You need at least ${pct(need.percent)}${points} on ${onName} for ${goal}.`;
    }
    case "already":
      return `You get ${goal} whatever you score on ${onName}, with the other scores as they are.`;
    case "out-of-reach":
      return `${goal} is out of reach through ${onName} alone: even 100% there gives ${pct(need.best)}.`;
    default:
      return onFinal ? "Set how much the final exam is worth first." : "Nothing is graded yet, so there’s nothing to work from.";
  }
}

/** A site time to ms: null for nothing; a number under 1e11 is seconds; strings are parsed. */
export function timeOf(t: string | number | null | undefined): number | null {
  if (t == null || t === "") return null;
  const ms = typeof t === "number" ? (t < 1e11 ? t * 1000 : t) : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}
