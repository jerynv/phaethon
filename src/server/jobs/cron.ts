/**
 * Five-field cron (minute hour day-of-month month day-of-week) in local time:
 * `*`, numbers, `a-b`, `a,b`, steps (`*\/15`, `1-30/5`), and day names
 * (sun…sat) and month names (jan…dec). As in Vixie cron, when both day fields
 * are restricted a day matches either. Also the friendly forms Settings and
 * the agent use (`daily 07:30`, `weekdays 08:00`, `weekly mon 09:00`,
 * `hourly`, `every 15m`), turned into cron by `toCron`.
 */

type Field = { values: Set<number>; star: boolean };
export type Cron = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field; source: string };

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function atom(s: string, field: number): number {
  const lower = s.toLowerCase();
  if (field === 4 && DAY_NAMES.includes(lower.slice(0, 3)) && /^[a-z]+$/.test(lower)) return DAY_NAMES.indexOf(lower.slice(0, 3));
  if (field === 3 && MONTH_NAMES.includes(lower.slice(0, 3)) && /^[a-z]+$/.test(lower)) return MONTH_NAMES.indexOf(lower.slice(0, 3)) + 1;
  if (!/^\d+$/.test(s)) throw new Error(`“${s}” isn’t a number`);
  const n = Number(s);
  const [lo, hi] = RANGES[field]!;
  if (n < lo || n > hi) throw new Error(`${n} is out of range ${lo}–${hi}`);
  return n;
}

function parseField(s: string, field: number): Field {
  const [lo, hi] = RANGES[field]!;
  const values = new Set<number>();
  let star = false;
  for (const part of s.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in “${part}”`);
    let a: number;
    let b: number;
    if (range === "*") {
      a = lo;
      b = hi;
      if (stepText === undefined) star = true;
    } else if (range!.includes("-")) {
      const [x, y] = range!.split("-");
      a = atom(x!, field);
      b = atom(y!, field);
      if (a > b) throw new Error(`“${range}” runs backwards`);
    } else {
      a = atom(range!, field);
      b = stepText === undefined ? a : hi;
    }
    for (let v = a; v <= b; v += step) values.add(field === 4 && v === 7 ? 0 : v);
  }
  return { values, star };
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A schedule needs five fields: minute hour day month weekday.");
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, i)) as [Field, Field, Field, Field, Field];
  return { minute, hour, dom, month, dow, source: parts.join(" ") };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.values.has(d.getDate());
  const dow = c.dow.values.has(d.getDay());
  if (c.dom.star && c.dow.star) return true;
  if (c.dom.star) return dow;
  if (c.dow.star) return dom;
  return dom || dow;
}

export function matches(c: Cron, d: Date): boolean {
  return c.minute.values.has(d.getMinutes()) && c.hour.values.has(d.getHours()) && c.month.values.has(d.getMonth() + 1) && dayMatches(c, d);
}

/** The first matching minute strictly after `after` (ms), within ~4 years; undefined if none. */
export function nextRun(c: Cron, after: number): number | undefined {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after + 4 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!c.month.values.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.values.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.values.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return undefined;
}

/** The most recent matching minute at or before `at`, looking back up to `withinMs`. */
export function previousRun(c: Cron, at: number, withinMs: number): number | undefined {
  const d = new Date(at);
  d.setSeconds(0, 0);
  const stop = at - withinMs;
  while (d.getTime() >= stop) {
    if (matches(c, d)) return d.getTime();
    d.setMinutes(d.getMinutes() - 1);
  }
  return undefined;
}

const TIME = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;

function hm(s: string | undefined): [number, number] {
  const m = TIME.exec((s ?? "09:00").trim());
  if (!m) throw new Error(`“${s}” isn’t a time like 07:30 or 7:30 am`);
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]) {
    const pm = m[3].toLowerCase() === "pm";
    if (h < 1 || h > 12) throw new Error(`“${s}” isn’t a time`);
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || min > 59) throw new Error(`“${s}” isn’t a time`);
  return [h, min];
}

/** Friendly forms to cron; a five-field expression passes through (checked). */
export function toCron(spec: string): string {
  const s = spec.trim().toLowerCase().replace(/\s+/g, " ");
  let m: RegExpExecArray | null;
  if ((m = /^every (\d+) ?(m|min|minutes?)$/.exec(s))) {
    const n = Number(m[1]);
    if (n < 5 || n > 59) throw new Error("Every N minutes needs N from 5 to 59.");
    return `*/${n} * * * *`;
  }
  if ((m = /^every (\d+) ?(h|hours?)$/.exec(s))) {
    const n = Number(m[1]);
    if (n < 1 || n > 23) throw new Error("Every N hours needs N from 1 to 23.");
    return `0 */${n} * * *`;
  }
  if (s === "hourly") return "0 * * * *";
  if ((m = /^daily(?: at)? ?(.*)$/.exec(s))) {
    const [h, min] = hm(m[1] || undefined);
    return `${min} ${h} * * *`;
  }
  if ((m = /^weekdays(?: at)? ?(.*)$/.exec(s))) {
    const [h, min] = hm(m[1] || undefined);
    return `${min} ${h} * * 1-5`;
  }
  if ((m = /^weekly(?: on)? ([a-z]+)(?: at)? ?(.*)$/.exec(s))) {
    const day = DAY_NAMES.indexOf(m[1]!.slice(0, 3));
    if (day < 0) throw new Error(`“${m[1]}” isn’t a day`);
    const [h, min] = hm(m[2] || undefined);
    return `${min} ${h} * * ${day}`;
  }
  parseCron(s);
  return s;
}

const DAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(h: number, m: number): string {
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** "Every day at 7:30 AM", "Weekdays at 8:00 AM", "Every 15 minutes", or the expression. */
export function describeCron(expr: string): string {
  let c: Cron;
  try {
    c = parseCron(expr);
  } catch {
    return expr;
  }
  const one = (f: Field) => (f.values.size === 1 ? [...f.values][0]! : undefined);
  const [min, hour] = [one(c.minute), one(c.hour)];
  const everyDay = c.dom.star && c.month.star;
  const step = /^\*\/(\d+)$/.exec(expr.split(/\s+/)[0]!);
  if (step && c.hour.star && everyDay && c.dow.star) return `Every ${step[1]} minutes`;
  const hstep = /^\*\/(\d+)$/.exec(expr.split(/\s+/)[1]!);
  if (min === 0 && hstep && everyDay && c.dow.star) return `Every ${hstep[1]} hours`;
  if (min === 0 && c.hour.star && everyDay && c.dow.star) return "Every hour";
  if (min !== undefined && hour !== undefined && everyDay) {
    const t = clock(hour, min);
    if (c.dow.star) return `Every day at ${t}`;
    const days = [...c.dow.values].sort();
    if (days.join() === "1,2,3,4,5") return `Weekdays at ${t}`;
    if (days.length === 1) return `Every ${DAY_LABEL[days[0]!]} at ${t}`;
    return `${days.map((d) => DAY_LABEL[d]!.slice(0, 3)).join(", ")} at ${t}`;
  }
  return expr;
}
