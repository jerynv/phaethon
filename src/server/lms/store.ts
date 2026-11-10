import fs from "node:fs";
import path from "node:path";
import type { Seen } from "./access.ts";
import type { Report } from "./material.ts";
import { Refusal } from "../rpc/registry.ts";
import { segment, write } from "./names.ts";
import { isKind, rustRound, type CourseGrades, type GradeSummary, type Kind } from "./types.ts";

/**
 * The vault's course-site records, all under `<vault>/.phaethon/`:
 * - `lms.json`: connections and what was imported from them (no secrets).
 * - `lms-accounts.json`: which account each connection is, as a fingerprint.
 * - `grades.json`: the numbers behind each course's grades.md.
 *
 * Every read-modify-write here is synchronous from load to save, so two
 * operations in the core (an import and a grades refresh, say) can't
 * interleave and lose each other's update.
 *
 * Files are written in the same layout serde wrote: struct fields in their
 * declared order, map keys sorted.
 */

export const STATE_DIR = ".phaethon";
export const FILE = "lms.json";
export const ACCOUNTS_FILE = "lms-accounts.json";
export const GRADES_FILE = "grades.json";
/** Where imported courses live, relative to the vault. */
export const COURSES_DIR = "courses";
const MAX_BYTES = 16 * 1024 * 1024;

export type FileRec = { path: string; size?: number; etag?: string; modified?: string; sha256?: string; version?: string };
export type LinkRec = { path?: string; title?: string; note?: string; via?: string; webPage: boolean };
export type Due = { title: string; due: string; anchor: string };

export type CourseState = {
  name: string;
  code?: string;
  term?: string;
  /** The course's folder name under `<vault>/courses/`. */
  folder: string;
  /** Remote file address → its local copy. */
  files: Record<string, FileRec>;
  /** Link out of the course → what came of it. */
  links: Record<string, LinkRec>;
  due: Due[];
  lastSync?: number;
  material?: Report;
  /** The first import was stopped before it finished; no space was given it yet. */
  partial?: boolean;
};

export type Conn = {
  id: string;
  kind: Kind;
  address: string;
  schoolName?: string;
  lastSync?: number;
  /** A hint, so listing connections never reads the keychain. */
  signedIn: boolean;
  courses: Record<string, CourseState>;
};

export type Store = { connections: Conn[] };
export type Accounts = { connections: Record<string, string> };

export type GradeRec = CourseGrades & {
  connection: string;
  courseId: string;
  course: string;
  /** "courses/<folder>" */
  folder: string;
  updated: number;
};
export type GradeBook = { courses: Record<string, GradeRec> };

// ---- serde-shaped JSON -----------------------------------------------------

/** A JSON object written with its keys in this order (serde struct order), skipping undefined. */
class Ordered {
  constructor(readonly entries: [string, unknown][]) {}
}

function obj(entries: [string, unknown][]): Ordered {
  return new Ordered(entries.filter(([, v]) => v !== undefined));
}

/** A BTreeMap: keys sorted by their UTF-8 bytes. */
function btree<T>(rec: Record<string, T>, map: (v: T) => unknown = (v) => v): Ordered {
  const keys = Object.keys(rec).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return new Ordered(keys.map((k) => [k, map(rec[k])]));
}

function pretty(v: unknown, indent = ""): string {
  const next = indent + "  ";
  if (v instanceof Ordered) {
    if (!v.entries.length) return "{}";
    return `{\n${v.entries.map(([k, x]) => `${next}${JSON.stringify(k)}: ${pretty(x, next)}`).join(",\n")}\n${indent}}`;
  }
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return `[\n${v.map((x) => `${next}${pretty(x, next)}`).join(",\n")}\n${indent}]`;
  }
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    return pretty(new Ordered(entries), indent);
  }
  return JSON.stringify(v ?? null);
}

function fileRecJson(f: FileRec): Ordered {
  return obj([
    ["path", f.path],
    ["size", f.size],
    ["etag", f.etag],
    ["modified", f.modified],
    ["sha256", f.sha256],
    ["version", f.version],
  ]);
}

function linkRecJson(l: LinkRec): Ordered {
  return obj([
    ["path", l.path],
    ["title", l.title],
    ["note", l.note],
    ["via", l.via],
    ["webPage", l.webPage ?? false],
  ]);
}

function courseJson(c: CourseState): Ordered {
  return obj([
    ["name", c.name],
    ["code", c.code],
    ["term", c.term],
    ["folder", c.folder],
    ["files", btree(c.files, fileRecJson)],
    ["links", btree(c.links, linkRecJson)],
    ["due", c.due.map((d) => obj([["title", d.title], ["due", d.due], ["anchor", d.anchor ?? ""]]))],
    ["lastSync", c.lastSync],
    ["material", c.material],
    ["partial", c.partial ? true : undefined],
  ]);
}

function connJson(c: Conn): Ordered {
  return obj([
    ["id", c.id],
    ["kind", c.kind],
    ["address", c.address],
    ["schoolName", c.schoolName],
    ["lastSync", c.lastSync],
    ["signedIn", c.signedIn],
    ["courses", btree(c.courses, courseJson)],
  ]);
}

function summaryJson(s: GradeSummary): Ordered {
  return obj([
    ["percent", s.percent],
    ["letter", s.letter],
    ["points", s.points],
    ["possible", s.possible],
  ]);
}

export function gradesJson(g: CourseGrades): [string, unknown][] {
  return [
    ["current", summaryJson(g.current ?? {})],
    ["final", g.final ? summaryJson(g.final) : undefined],
    ["groups", g.groups.map((x) => obj([["name", x.name], ["weight", x.weight]]))],
    [
      "items",
      g.items.map((i) =>
        obj([
          ["title", i.title],
          ["group", i.group],
          ["score", i.score],
          ["possible", i.possible],
          ["percent", i.percent],
          ["grade", i.grade],
          ["due", i.due],
          ["submitted", i.submitted],
          ["graded", i.graded],
          ["late", i.late],
          ["missing", i.missing],
          ["excused", i.excused],
          ["comments", i.comments],
        ]),
      ),
    ],
    ["note", g.note],
  ];
}

function gradeRecJson(r: GradeRec): Ordered {
  return obj([
    ["connection", r.connection],
    ["courseId", r.courseId],
    ["course", r.course],
    ["folder", r.folder],
    ["updated", r.updated],
    ...gradesJson(r),
  ]);
}

// ---- reading -----------------------------------------------------------------

class Damaged extends Error {}

function need<T>(o: Record<string, unknown>, key: string, check: (v: unknown) => v is T, what: string): T {
  if (!(key in o) || o[key] === undefined) throw new Damaged(`missing field \`${key}\``);
  const v = o[key];
  if (!check(v)) throw new Damaged(`invalid type for \`${key}\`, expected ${what}`);
  return v;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function opt<T>(o: Record<string, unknown>, key: string, check: (v: unknown) => v is T, what: string): T | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (!check(v)) throw new Damaged(`invalid type for \`${key}\`, expected ${what}`);
  return v;
}

function mapOf<T>(o: Record<string, unknown>, key: string, each: (v: unknown) => T): Record<string, T> {
  const v = o[key];
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new Damaged(`invalid type for \`${key}\`, expected a map`);
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(v)) out[k] = each(x);
  return out;
}

function parseFileRec(v: unknown): FileRec {
  if (!isObj(v)) throw new Damaged("invalid type, expected struct FileRec");
  return {
    path: need(v, "path", isStr, "a string"),
    size: opt(v, "size", isNum, "u64"),
    etag: opt(v, "etag", isStr, "a string"),
    modified: opt(v, "modified", isStr, "a string"),
    sha256: opt(v, "sha256", isStr, "a string"),
    version: opt(v, "version", isStr, "a string"),
  };
}

function parseLinkRec(v: unknown): LinkRec {
  if (!isObj(v)) throw new Damaged("invalid type, expected struct LinkRec");
  return {
    path: opt(v, "path", isStr, "a string"),
    title: opt(v, "title", isStr, "a string"),
    note: opt(v, "note", isStr, "a string"),
    via: opt(v, "via", isStr, "a string"),
    webPage: opt(v, "webPage", isBool, "a boolean") ?? false,
  };
}

function parseCourse(v: unknown): CourseState {
  if (!isObj(v)) throw new Damaged("invalid type, expected struct CourseState");
  const due = v.due === undefined || v.due === null ? [] : v.due;
  if (!Array.isArray(due)) throw new Damaged("invalid type for `due`, expected a sequence");
  const material = v.material;
  if (material !== undefined && material !== null && (!isObj(material) || !Array.isArray(material.files) || !isNum(material.version))) throw new Damaged("invalid type for `material`");
  const c: CourseState = {
    name: need(v, "name", isStr, "a string"),
    code: opt(v, "code", isStr, "a string"),
    term: opt(v, "term", isStr, "a string"),
    folder: need(v, "folder", isStr, "a string"),
    files: mapOf(v, "files", parseFileRec),
    links: mapOf(v, "links", parseLinkRec),
    due: due.map((d) => {
      if (!isObj(d)) throw new Damaged("invalid type, expected struct Due");
      return { title: need(d, "title", isStr, "a string"), due: need(d, "due", isStr, "a string"), anchor: opt(d, "anchor", isStr, "a string") ?? "" };
    }),
    lastSync: opt(v, "lastSync", isNum, "u64"),
    material: material === null || material === undefined ? undefined : (material as unknown as Report),
  };
  if (opt(v, "partial", isBool, "a boolean")) c.partial = true;
  return c;
}

function parseConn(v: unknown): Conn {
  if (!isObj(v)) throw new Damaged("invalid type, expected struct Conn");
  const kind = need(v, "kind", isStr, "a string");
  if (!isKind(kind)) throw new Damaged(`unknown variant \`${kind}\`, expected one of \`canvas\`, \`brightspace\`, \`moodle\`, \`blackboard\``);
  return {
    id: need(v, "id", isStr, "a string"),
    kind,
    address: need(v, "address", isStr, "a string"),
    schoolName: opt(v, "schoolName", isStr, "a string"),
    lastSync: opt(v, "lastSync", isNum, "u64"),
    signedIn: opt(v, "signedIn", isBool, "a boolean") ?? false,
    courses: mapOf(v, "courses", parseCourse),
  };
}

/** Reads a state file through lstat (never a symlink) with a size cap; null when missing. */
function readState(file: string, readErr: (e: string) => string, notPlain: string): string | null {
  let meta: fs.Stats;
  try {
    meta = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Refusal(readErr((e as Error).message));
  }
  if (!meta.isFile() || meta.size > MAX_BYTES) throw new Refusal(notPlain);
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Refusal(readErr((e as Error).message));
  }
}

function parseWith<T>(text: string, parse: (v: unknown) => T, damaged: (e: string) => string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Refusal(damaged((e as Error).message));
  }
  try {
    return parse(raw);
  } catch (e) {
    if (e instanceof Damaged) throw new Refusal(damaged(e.message));
    throw e;
  }
}

/** The vault's own state folder, writable through a symlinked vault root too. */
function writeState(root: string, file: string, text: string): void {
  let real = root;
  try {
    real = fs.realpathSync.native(root);
  } catch {
    // dirIn reports the problem.
  }
  write(real, `${STATE_DIR}/${file}`, text);
}

export function load(root: string): Store {
  const text = readState(
    path.join(root, STATE_DIR, FILE),
    (e) => `This space’s course sites couldn’t be read: ${e}`,
    "This space’s course sites file isn’t a plain file Phaethon can read.",
  );
  if (text === null) return { connections: [] };
  return parseWith(
    text,
    (v) => {
      if (!isObj(v)) throw new Damaged("invalid type, expected struct Store");
      const list = v.connections ?? [];
      if (!Array.isArray(list)) throw new Damaged("invalid type for `connections`, expected a sequence");
      return { connections: list.map(parseConn) };
    },
    (e) => `This space’s course sites file is damaged (${e}). Fix or remove .phaethon/lms.json.`,
  );
}

export function serializeStore(store: Store): string {
  return pretty(obj([["connections", store.connections.map(connJson)]]));
}

export function save(root: string, store: Store): void {
  try {
    writeState(root, FILE, serializeStore(store));
  } catch (e) {
    throw new Refusal(`This space’s course sites couldn’t be saved: ${(e as Error).message}`);
  }
}

/** Load, change and save lms.json with nothing able to run in between. */
export function update<T>(root: string, change: (store: Store) => T): T {
  const store = load(root);
  const out = change(store);
  save(root, store);
  return out;
}

export function getConn(store: Store, id: string): Conn | undefined {
  return store.connections.find((c) => c.id === id);
}

/** Every course folder in use in the vault, by any connection. */
export function folders(store: Store): string[] {
  return store.connections.flatMap((c) => Object.values(c.courses).map((s) => s.folder));
}

export function loadAccounts(root: string): Accounts {
  const text = readState(path.join(root, STATE_DIR, ACCOUNTS_FILE), (e) => `The course site accounts couldn’t be read: ${e}`, "lms-accounts.json isn’t a plain file Phaethon can read.");
  if (text === null) return { connections: {} };
  return parseWith(
    text,
    (v) => {
      if (!isObj(v)) throw new Damaged("invalid type, expected struct Accounts");
      return { connections: mapOf(v, "connections", (x) => (isStr(x) ? x : (() => { throw new Damaged("invalid type, expected a string"); })())) };
    },
    (e) => `lms-accounts.json is damaged (${e}). Remove .phaethon/lms-accounts.json and sign in again.`,
  );
}

export function saveAccounts(root: string, a: Accounts): void {
  try {
    writeState(root, ACCOUNTS_FILE, pretty(obj([["connections", btree(a.connections)]])));
  } catch (e) {
    throw new Refusal(`The course site accounts couldn’t be saved: ${(e as Error).message}`);
  }
}

export function gradeKey(connection: string, courseId: string): string {
  return `${connection}/${courseId}`;
}

export function loadGrades(root: string): GradeBook {
  const text = readState(path.join(root, STATE_DIR, GRADES_FILE), (e) => `This space’s grades couldn’t be read: ${e}`, "This space’s grades file isn’t a plain file Phaethon can read.");
  if (text === null) return { courses: {} };
  return parseWith(
    text,
    (v) => {
      if (!isObj(v)) throw new Damaged("invalid type, expected struct GradeBook");
      return {
        courses: mapOf(v, "courses", (x) => {
          if (!isObj(x)) throw new Damaged("invalid type, expected struct GradeRec");
          need(x, "connection", isStr, "a string");
          need(x, "courseId", isStr, "a string");
          need(x, "course", isStr, "a string");
          need(x, "folder", isStr, "a string");
          need(x, "updated", isNum, "u64");
          const r = x as unknown as GradeRec;
          return { ...r, current: isObj(r.current) ? r.current : {}, groups: Array.isArray(r.groups) ? r.groups : [], items: Array.isArray(r.items) ? r.items : [] };
        }),
      };
    },
    (e) => `This space’s grades file is damaged (${e}). Remove .phaethon/grades.json and refresh grades.`,
  );
}

export function serializeGrades(book: GradeBook): string {
  return pretty(obj([["courses", btree(book.courses, gradeRecJson)]]));
}

export function saveGrades(root: string, book: GradeBook): void {
  try {
    writeState(root, GRADES_FILE, serializeGrades(book));
  } catch (e) {
    throw new Refusal(`This space’s grades couldn’t be saved: ${(e as Error).message}`);
  }
}

/** Keep one course's grades (read, replace, write, with nothing in between). */
export function putGrades(root: string, rec: GradeRec): void {
  const book = loadGrades(root);
  book.courses[gradeKey(rec.connection, rec.courseId)] = rec;
  saveGrades(root, book);
}

/** An imported course's folder, when it's still a plain folder (never through a symlink). */
export function courseDir(root: string, folder: string): string | null {
  const coursesRoot = path.join(root, COURSES_DIR);
  const dir = path.join(coursesRoot, folder);
  if (segment(folder) !== folder) return null;
  try {
    if (!fs.lstatSync(coursesRoot).isDirectory() || !fs.lstatSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  return dir;
}

// ---- numbers and dates -------------------------------------------------------

/** A number as a person writes it: at most two decimals, no trailing zeros. */
export function num(x: number): string {
  const s = (rustRound(x * 100) / 100).toFixed(2);
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

/** "86.4% (B+)", "B+", "432 of 500 points": a grade in a few words, or null. */
export function gradeWords(g: GradeSummary | undefined): string | null {
  if (!g) return null;
  const points = g.points !== undefined && g.possible !== undefined ? `${num(g.points)} of ${num(g.possible)} points` : null;
  if (g.percent !== undefined && g.letter !== undefined) return `${num(g.percent)}% (${g.letter})`;
  if (g.percent !== undefined) return `${num(g.percent)}%`;
  if (g.letter !== undefined) return g.letter;
  return points;
}

/** Seconds since the epoch for an RFC 3339 time; a date alone is midnight UTC. */
export function parseTime(input: string): number | null {
  const s = input.trim();
  const n = (a: number, len: number): number | null => {
    const t = s.slice(a, a + len);
    return t.length === len && /^[0-9]+$/.test(t) ? Number(t) : null;
  };
  const y = n(0, 4);
  const mo = n(5, 2);
  const d = n(8, 2);
  if (y === null || mo === null || d === null) return null;
  if (s[4] !== "-" || s[7] !== "-" || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const days = daysFromCivil(y, mo, d);
  if (s.length === 10) return days * 86400;
  if (!["T", "t", " "].includes(s[10] ?? "")) return null;
  const h = n(11, 2);
  const mi = n(14, 2);
  if (h === null || mi === null) return null;
  let at = 16;
  let sec = 0;
  if (s[16] === ":") {
    const ss = n(17, 2);
    if (ss === null) return null;
    sec = ss;
    at = 19;
    if (s[19] === ".") {
      at = 20;
      while (at < s.length && /[0-9]/.test(s[at])) at++;
    }
  }
  let offset = 0;
  const c = s[at];
  if (c === undefined || c === "Z" || c === "z") offset = 0;
  else if (c === "+" || c === "-") {
    const oh = n(at + 1, 2);
    const om = n(at + 4, 2);
    if (oh === null || om === null) return null;
    offset = (oh * 3600 + om * 60) * (c === "-" ? -1 : 1);
  } else return null;
  return days * 86400 + h * 3600 + mi * 60 + sec - offset;
}

function daysFromCivil(y0: number, m: number, d: number): number {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** [year, month, day, hour, minute, weekday] in UTC. */
export function utcParts(secs: number): [number, number, number, number, number, number] {
  const t = new Date(secs * 1000);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCDay()];
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A time as the person reads it, in this computer's time zone: "Tue Oct 14 2026, 11:59 PM". */
export function displayTime(secs: number): string {
  const t = new Date(secs * 1000);
  const h = t.getHours();
  const [h12, ampm] = h === 0 ? [12, "AM"] : h < 12 ? [h, "AM"] : h === 12 ? [12, "PM"] : [h - 12, "PM"];
  return `${DAYS[t.getDay()]} ${MONTHS[t.getMonth()]} ${t.getDate()} ${t.getFullYear()}, ${h12}:${String(t.getMinutes()).padStart(2, "0")} ${ampm}`;
}

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

export function nowMs(): number {
  return Date.now();
}

/** Dated items still ahead of `now`, soonest first. */
export function upcoming(due: Due[], now: number): [number, Due][] {
  const v: [number, Due][] = [];
  for (const d of due) {
    const t = parseTime(d.due);
    if (t !== null && t >= now) v.push([t, d]);
  }
  v.sort((a, b) => a[0] - b[0]);
  return v;
}

// ---- the agent's index -------------------------------------------------------

const INDEX_COURSES = 20;
const INDEX_DUE = 3;
const INDEX_MAX = 4000;
const ALL_PARTS = ["overview", "syllabus", "assignments", "announcements", "files", "grades"] as const;

const INDEX_HEADER =
  "# Courses\n\nThese courses were imported from the user's course site, one folder each under courses/ (read-only: they are the site's copy). " +
  "Before answering anything about a course, read its folder with your file tools: README.md (what's coming up, the textbooks and readings), " +
  "syllabus.md, assignments.md, grades.md (their grades so far), modules.md, and the files and readings the question touches. PDFs and Office files have a text copy beside them " +
  "(the same name ending in .md); read that. Answer from the course's own material and say which file it came from. " +
  "Where a course lists only some parts, the user chose not to show this space the rest; don't ask for it.\n\n";

/** A short index of the courses a space may see, for the system prompt, or null when it sees none. */
export function promptIndex(courses: Seen[], grades: GradeBook, now: number): string | null {
  const lines: string[] = [];
  for (const seen of courses) {
    const c = seen.state;
    const label = c.code !== undefined && !c.name.includes(c.code) ? `${c.name} (${c.code})` : c.name;
    let line = `- ${label}: courses/${c.folder}/`;
    if (!ALL_PARTS.every((p) => seen.parts.has(p))) {
      line += ` (this space sees only: ${ALL_PARTS.filter((p) => seen.parts.has(p)).join(", ")})`;
    }
    if (seen.parts.has("overview") || seen.parts.has("assignments")) {
      const next = upcoming(c.due, now)
        .slice(0, INDEX_DUE)
        .map(([t, d]) => `${d.title} (${displayTime(t)})`);
      if (next.length) line += ` Next due: ${next.join("; ")}.`;
    }
    if (seen.parts.has("grades")) {
      const g = gradeWords(grades.courses[seen.key]?.current);
      if (g) line += ` Current grade: ${g} (grades.md).`;
    }
    lines.push(line);
  }
  if (!lines.length) return null;
  let s = INDEX_HEADER;
  let shown = 0;
  for (const l of lines) {
    if (shown >= INDEX_COURSES || Buffer.byteLength(s) + Buffer.byteLength(l) > INDEX_MAX) {
      s += "- …and more under courses/\n";
      break;
    }
    s += l + "\n";
    shown++;
  }
  return s.trimEnd();
}

/** Pretty JSON with every object's keys sorted, as serde_json's `Value` (no preserve_order) writes it. */
export function prettySorted(value: unknown): string {
  const sortAll = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortAll);
    if (v !== null && typeof v === "object") return btree(v as Record<string, unknown>, sortAll);
    return v;
  };
  return pretty(sortAll(value));
}
