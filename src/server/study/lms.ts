import fs from "node:fs";
import path from "node:path";

/**
 * The parts of the course-site store (`<vault>/.phaethon/lms.json`) that
 * Study and the planner read. Read-only here; the LMS module owns writing it.
 * Mirrors `lms::store` and `lms::material` (Rust) for the fields used.
 */

export type Due = { title: string; due: string; anchor?: string };

export type FileQuality = {
  path: string;
  pages?: number;
  typed: number;
  handwriting?: number[];
  unreadable?: number[];
  pictures?: [number, number][];
  knownWords?: number;
  size?: number;
  copyModified?: number;
};

export type Report = { version: number; files: FileQuality[]; cantRecognise?: string };

export type CourseState = {
  name: string;
  code?: string;
  term?: string;
  folder: string;
  due?: Due[];
  lastSync?: number;
  material?: Report;
  partial?: boolean;
  [key: string]: unknown;
};

export type Conn = { id: string; kind?: string; courses?: Record<string, CourseState>; [key: string]: unknown };
export type Store = { connections: Conn[] };

const MAX_BYTES = 16 * 1024 * 1024;

/** `<vault>/.phaethon/lms.json`; missing → empty; unreadable or damaged → throws the Rust message. */
export function loadStore(vaultRoot: string): Store {
  const file = path.join(vaultRoot, ".phaethon", "lms.json");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { connections: [] };
    throw `This space’s course sites couldn’t be read: ${(e as Error).message}`;
  }
  if (!st.isFile() || st.size > MAX_BYTES) throw "This space’s course sites file isn’t a plain file Phaethon can read.";
  let v: unknown;
  try {
    v = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw `This space’s course sites file is damaged (${(e as Error).message}). Fix or remove .phaethon/lms.json.`;
  }
  const conns = (v as { connections?: unknown })?.connections;
  const out: Store = { connections: [] };
  if (!Array.isArray(conns)) return out;
  for (const c of conns) {
    if (!c || typeof c !== "object" || typeof (c as Conn).id !== "string") continue;
    const courses: Record<string, CourseState> = {};
    for (const [id, s] of Object.entries(((c as Conn).courses ?? {}) as Record<string, unknown>)) {
      const cs = s as CourseState;
      if (cs && typeof cs.name === "string" && typeof cs.folder === "string") courses[id] = cs;
    }
    out.connections.push({ ...(c as Conn), courses });
  }
  return out;
}

/** Text the importer puts on a page's heading when it was read from a picture. */
export const RECOGNISED = "(recognised from handwriting or a scan; may contain mistakes)";

/** Seconds since the epoch for `YYYY-MM-DD` (UTC midnight) or an RFC 3339-ish time (`parse_time`). */
export function parseTime(raw: string): number | null {
  const s = raw.trim();
  const num = (a: number, n: number): number | null => {
    const t = s.slice(a, a + n);
    return t.length === n && /^[0-9]+$/.test(t) ? Number(t) : null;
  };
  const y = num(0, 4);
  const mo = num(5, 2);
  const d = num(8, 2);
  if (y === null || mo === null || d === null) return null;
  if (s[4] !== "-" || s[7] !== "-" || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const days = daysFromCivil(y, mo, d);
  if (Buffer.byteLength(s) === 10) return days * 86_400;
  if (!["T", "t", " "].includes(s[10] ?? "")) return null;
  const h = num(11, 2);
  const mi = num(14, 2);
  if (h === null || mi === null) return null;
  let at = 16;
  let sec = 0;
  if (s[16] === ":") {
    const ss = num(17, 2);
    if (ss === null) return null;
    sec = ss;
    at = 19;
    if (s[19] === ".") {
      at = 20;
      while (at < s.length && /[0-9]/.test(s[at]!)) at++;
    }
  }
  let offset = 0;
  const c = s[at];
  if (c === undefined || c === "Z" || c === "z") offset = 0;
  else if (c === "+" || c === "-") {
    const oh = num(at + 1, 2);
    const om = num(at + 4, 2);
    if (oh === null || om === null) return null;
    offset = (oh * 3600 + om * 60) * (c === "-" ? -1 : 1);
  } else return null;
  return days * 86_400 + h * 3600 + mi * 60 + sec - offset;
}

/** Days since 1970-01-01 (Hinnant). */
export function daysFromCivil(y0: number, m: number, d: number): number {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Dated items still ahead of `now` (seconds), soonest first. */
export function upcoming(due: readonly Due[], now: number): [number, Due][] {
  const v: [number, Due][] = [];
  for (const d of due) {
    const t = typeof d?.due === "string" ? parseTime(d.due) : null;
    if (t !== null && t >= now) v.push([t, d]);
  }
  return v.map((x, i) => [x, i] as const).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]).map(([x]) => x);
}

export const flaggedPages = (f: FileQuality): number => (f.handwriting?.length ?? 0) + (f.unreadable?.length ?? 0);
export const pictureCount = (f: FileQuality): number => (f.pictures ?? []).reduce((n, [, c]) => n + c, 0);
export const isFlagged = (f: FileQuality): boolean => flaggedPages(f) > 0 || (f.pictures ?? []).length > 0;

/** Handwriting and unreadable pages (sorted), then typed pages with pictures. */
export function picturePages(f: FileQuality): number[] {
  const out = [...(f.handwriting ?? []), ...(f.unreadable ?? [])].sort((a, b) => a - b);
  for (const [p] of f.pictures ?? []) out.push(p);
  return out;
}

export type Summary = {
  documents: number;
  typedDocuments: number;
  handwritingPages: number;
  unreadablePages: number;
  pictures: number;
  readability?: "good" | "fair" | "poor";
  knownWords?: number;
  cantRecognise?: string;
  lines: string[];
};

const GOOD = 0.85;
const FAIR = 0.65;

/** `lms::material::summarise` for the documents `keep` accepts. */
export function summarise(report: Report, keep: (f: FileQuality) => boolean = () => true): Summary {
  const files = report.files.filter(keep);
  const s: Summary = { documents: files.length, typedDocuments: 0, handwritingPages: 0, unreadablePages: 0, pictures: 0, lines: [] };
  if (report.cantRecognise !== undefined) s.cantRecognise = report.cantRecognise;
  let known = 0;
  let weight = 0;
  for (const f of files) {
    s.handwritingPages += f.handwriting?.length ?? 0;
    s.unreadablePages += f.unreadable?.length ?? 0;
    s.pictures += pictureCount(f);
    if (!isFlagged(f)) s.typedDocuments++;
    if (typeof f.knownWords === "number") {
      known += f.knownWords * (f.handwriting?.length ?? 0);
      weight += f.handwriting?.length ?? 0;
    }
  }
  if (weight > 0) {
    const share = known / weight;
    s.knownWords = share;
    s.readability = share >= GOOD ? "good" : share >= FAIR ? "fair" : "poor";
  }
  if (s.handwritingPages > 0) {
    const how =
      s.readability === "good"
        ? "read with text recognition; it reads well, but may contain mistakes"
        : s.readability === "fair"
          ? "read with text recognition; expect some mistakes"
          : s.readability === "poor"
            ? "read with text recognition, and much of it reads badly: expect many mistakes"
            : "read with text recognition; may contain mistakes";
    s.lines.push(`${s.handwritingPages} ${s.handwritingPages === 1 ? "page is" : "pages are"} handwriting or scans: ${how}.`);
  }
  if (s.unreadablePages > 0) {
    const why = s.cantRecognise !== undefined ? `: ${s.cantRecognise}` : " (pictures with no words, or text recognition couldn’t read them)";
    s.lines.push(`${s.unreadablePages} ${s.unreadablePages === 1 ? "page couldn’t be read" : "pages couldn’t be read"} at all${why}.`);
  }
  if (s.pictures > 0) {
    const what = s.pictures === 1 ? "picture (a figure, diagram or photo)" : "pictures (figures, diagrams or photos)";
    s.lines.push(`${s.pictures} ${what}: ${s.pictures === 1 ? "it can’t be read as text" : "they can’t be read as text"}.`);
  }
  if (s.lines.length === 0 && s.documents > 0) {
    s.lines.push(`${s.documents === 1 ? "The document is" : `All ${s.documents} documents are`} typed text, read as it is.`);
  }
  return s;
}
