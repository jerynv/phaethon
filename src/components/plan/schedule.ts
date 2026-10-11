/**
 * The study planner's schedule: review sessions spread before each exam
 * (spaced out, closer together near the day) and a work session before each
 * due date, on the days the person studies, never more sessions in a day than
 * they chose. Pure and deterministic (same input, same plan), so `node --test`
 * runs scripts/unit/schedule.test.ts. Days are local calendar days as "YYYY-MM-DD".
 */

export type PlanExam = { id: string; title: string; course?: string; date: string };
export type PlanDue = { title: string; course: string; folder: string; /** ms since the epoch */ due: number; link: string };

export type PlanInput = {
  today: string;
  exams: readonly PlanExam[];
  due: readonly PlanDue[];
  /** 0 = Sunday. */
  studyDays: readonly number[];
  sessionsPerDay: number;
  /** Course (folder or name) → its decks' titles, for links to study. */
  decks?: Readonly<Record<string, readonly string[]>>;
  /** How far ahead to plan, in days. */
  horizon?: number;
  /** A due time's local day (tests pass a fixed one). */
  dayOf?: (ms: number) => string;
};

export type Session = {
  /** Stable across re-planning, so a check-off stays with its session. */
  id: string;
  day: string;
  kind: "review" | "final-review" | "work";
  /** "Review for Test 1". */
  title: string;
  course?: string;
  /** The exam's or due date's day. */
  target: string;
  /** Decks of the course to study with, if any. */
  decks: readonly string[];
  /** For work: the assignment's file in the space. */
  link?: string;
};

export type Plan = {
  days: { day: string; sessions: Session[] }[];
  /** Sessions that didn't fit before their date (too few study days or slots). */
  unplaced: { title: string; target: string }[];
};

/** Days before an exam to review on, nearest first (spacing grows further out). */
const EXAM_OFFSETS = [1, 2, 4, 7, 11, 16];

const DAY = 86_400_000;
export const toMs = (day: string) => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10));
export const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => fromMs(toMs(day) + n * DAY);
export const weekday = (day: string) => new Date(toMs(day)).getUTCDay();
export const daysBetween = (a: string, b: string) => Math.round((toMs(b) - toMs(a)) / DAY);

/** A local time's calendar day. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function decksFor(input: PlanInput, ...keys: (string | undefined)[]): readonly string[] {
  for (const k of keys) if (k && input.decks?.[k]?.length) return input.decks[k];
  return [];
}

export function makePlan(input: PlanInput): Plan {
  const horizon = input.horizon ?? 28;
  const end = addDays(input.today, horizon);
  const studyDays = new Set(input.studyDays);
  const cap = Math.max(1, Math.floor(input.sessionsPerDay));
  const dayOf = input.dayOf ?? localDay;
  const load = new Map<string, Session[]>();
  const unplaced: Plan["unplaced"] = [];

  /** The latest study day from `latest` back to today with room, or null. */
  const slot = (latest: string): string | null => {
    for (let d = latest; d >= input.today; d = addDays(d, -1)) {
      if (studyDays.has(weekday(d)) && (load.get(d)?.length ?? 0) < cap) return d;
    }
    return null;
  };
  const place = (wanted: string, s: Omit<Session, "day">) => {
    const day = slot(wanted);
    if (!day) {
      unplaced.push({ title: s.title, target: s.target });
      return;
    }
    load.set(day, [...(load.get(day) ?? []), { ...s, day }]);
  };

  type Target = { date: string; order: string; sessions: () => void };
  const targets: Target[] = [];
  for (const e of input.exams) {
    if (e.date < input.today || e.date > end) continue;
    targets.push({
      date: e.date,
      order: `0${e.title}`,
      sessions: () => {
        const decks = decksFor(input, e.course);
        let wanted = addDays(e.date, -1);
        EXAM_OFFSETS.forEach((off, k) => {
          const want = addDays(e.date, -off);
          if (want < input.today) return;
          // Spaced sessions never stack on a day already used for this exam.
          const latest = want < wanted ? want : wanted;
          const day = slot(latest);
          if (!day) {
            unplaced.push({ title: `Review for ${e.title}`, target: e.date });
            return;
          }
          wanted = addDays(day, -1);
          const s: Session = {
            id: `exam:${e.id}:${k}`,
            day,
            kind: k === 0 ? "final-review" : "review",
            title: k === 0 ? `Final review for ${e.title}` : `Review for ${e.title}`,
            course: e.course,
            target: e.date,
            decks,
          };
          load.set(day, [...(load.get(day) ?? []), s]);
        });
      },
    });
  }
  for (const d of input.due) {
    const date = dayOf(d.due);
    if (date < input.today || date > end) continue;
    targets.push({
      date,
      order: `1${d.course}${d.title}`,
      sessions: () =>
        place(date === input.today ? date : addDays(date, -1), {
          id: `due:${d.link}:${d.title}:${d.due}`,
          kind: "work",
          title: `Work on ${d.title}`,
          course: d.course,
          target: date,
          decks: decksFor(input, d.folder, d.course),
          link: d.link,
        }),
    });
  }
  // Soonest first: what's due sooner gets the days nearest it.
  targets.sort((a, b) => (a.date === b.date ? a.order.localeCompare(b.order) : a.date < b.date ? -1 : 1));
  for (const t of targets) t.sessions();

  const days = [...load.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, sessions]) => ({ day, sessions: [...sessions].sort((a, b) => (a.target === b.target ? a.title.localeCompare(b.title) : a.target < b.target ? -1 : 1)) }));
  return { days, unplaced };
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Thursday 15 October". */
export function dayName(day: string): string {
  const d = new Date(toMs(day));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The plan as study/plan.md: a checklist by day, then the exams and what's due. */
export function planMarkdown(plan: Plan, input: PlanInput, done: ReadonlySet<string>, sessionMinutes: number): string {
  const lines = [`# Study plan`, ``, `Made by Phaethon on ${dayName(input.today)}. Sessions of ${sessionMinutes} minutes.`, ``];
  const exams = input.exams.filter((e) => e.date >= input.today);
  if (exams.length) {
    lines.push(`## Exams`, ``);
    for (const e of exams) lines.push(`- ${dayName(e.date)}: ${e.title}${e.course ? ` (${e.course})` : ""}`);
    lines.push(``);
  }
  lines.push(`## Schedule`, ``);
  if (!plan.days.length) lines.push(`Nothing to plan yet.`, ``);
  for (const d of plan.days) {
    lines.push(`### ${dayName(d.day)}`, ``);
    for (const s of d.sessions) {
      const extra = [s.course, s.decks.length ? `decks: ${s.decks.join(", ")}` : "", s.link ? `[details](${s.link.replace(/ /g, "%20")})` : ""].filter(Boolean);
      lines.push(`- [${done.has(s.id) ? "x" : " "}] ${s.title}${extra.length ? ` (${extra.join("; ")})` : ""}`);
    }
    lines.push(``);
  }
  if (plan.unplaced.length) {
    lines.push(`## Didn’t fit`, ``);
    for (const u of plan.unplaced) lines.push(`- ${u.title} (before ${dayName(u.target)})`);
    lines.push(``);
  }
  return lines.join("\n");
}
