import fs from "node:fs";
import path from "node:path";
import { resolveIn } from "../core/resolve.ts";
import { spaceDir, spacesRoot, vaultRoot } from "../core/vault.ts";
import { Refusal } from "../rpc/registry.ts";
import { summarise, type Summary } from "./material.ts";
import { write } from "./names.ts";
import { COURSES_DIR, courseDir, gradeKey, load as loadStore, loadGrades, nowSecs, prettySorted, promptIndex, STATE_DIR, type CourseState } from "./store.ts";

/**
 * Which imported courses each space can see, and which parts of them.
 *
 * Courses belong to the vault (`<vault>/courses/`, `<vault>/.phaethon/lms.json`).
 * A space sees a course only where `<vault>/.phaethon/course-access.json`
 * allows it, part by part:
 *
 *   { "school": { "canvas-iu-instructure-com/2411651": ["overview", "syllabus", "files"] } }
 *
 * Inside a space the courses it may see appear as `courses/<folder>/...`, and
 * everything that reads course material in a space goes through `Visible`, so
 * what a space may see is decided here and nowhere else. The file is
 * user-editable, so every entry is validated on every read.
 */

export const FILE = "course-access.json";
const MAX_BYTES = 1024 * 1024;

export type Part = "overview" | "syllabus" | "assignments" | "announcements" | "files" | "grades";
export const ALL_PARTS: readonly Part[] = ["overview", "syllabus", "assignments", "announcements", "files", "grades"];

export function parsePart(s: unknown): Part | null {
  return typeof s === "string" && (ALL_PARTS as readonly string[]).includes(s) ? (s as Part) : null;
}

function comps(p: string): string[] {
  return p.split(/[\\/]+/).filter((c, i) => c !== "" && !(c === "." && i > 0));
}

/**
 * The part a path inside a course folder belongs to, by its first component,
 * compared without case and without trailing dots and spaces. Anything not
 * named here is "files".
 */
export function partOf(sub: string): Part {
  const parts = comps(sub);
  if (!parts.length) return "overview";
  const name = parts[0].toLowerCase().replace(/[. ]+$/, "");
  const only = parts.length === 1;
  if (name === "readme.md" && only) return "overview";
  if (name === "syllabus.md") return "syllabus";
  if (name === "assignments.md") return "assignments";
  if (name === "announcements.md") return "announcements";
  if (name === "grades.md") return "grades";
  return "files";
}

export function courseKey(connection: string, courseId: string): string {
  return gradeKey(connection, courseId);
}

export function validKey(key: string): boolean {
  const i = key.indexOf("/");
  if (i < 0) return false;
  const conn = key.slice(0, i);
  const course = key.slice(i + 1);
  const plain = (s: string, extra: RegExp) => s.length > 0 && Buffer.byteLength(s) <= 128 && [...s].every((c) => /[A-Za-z0-9-]/.test(c) || extra.test(c));
  return plain(conn, /^$/) && plain(course, /^[_.:]$/);
}

/** Space id → course key → the parts it may see. */
export type AccessMap = Map<string, Map<string, Set<Part>>>;
export type Loaded = { map: AccessMap; problems: string[] };

function file(): string {
  return path.join(vaultRoot(), STATE_DIR, FILE);
}

function spaceOk(space: string): boolean {
  try {
    spaceDir(space);
    return true;
  } catch {
    return false;
  }
}

/** The file's text, or null when there is none. Never through a link, never huge. */
function readRaw(): string | null {
  const p = file();
  let m: fs.Stats;
  try {
    m = fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Refusal(`course-access.json couldn’t be read: ${(e as Error).message}`);
  }
  if (!m.isFile() || m.size > MAX_BYTES) throw new Refusal("course-access.json isn’t a plain file Phaethon can read");
  try {
    return fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new Refusal(`course-access.json couldn’t be read: ${(e as Error).message}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function sortedEntries<T>(o: Record<string, T>): [string, T][] {
  return Object.keys(o)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((k) => [k, o[k]]);
}

/** Read and validate course-access.json. A missing file means no space sees any course. */
export function load(): Loaded {
  let raw: string | null;
  try {
    raw = readRaw();
  } catch (e) {
    return { map: new Map(), problems: [`${(e as Error).message}, so no space can see any course.`] };
  }
  if (raw === null) return { map: new Map(), problems: [] };
  let top: unknown;
  try {
    top = JSON.parse(raw);
  } catch {
    top = null;
  }
  if (!isObj(top)) {
    return { map: new Map(), problems: ["course-access.json has a typing mistake, so no space can see any course. Fix it in a text editor or delete it."] };
  }
  const out: Loaded = { map: new Map(), problems: [] };
  for (const [space, courses] of sortedEntries(top)) {
    if (!spaceOk(space)) {
      out.problems.push(`“${space}” is skipped: there’s no space by that name.`);
      continue;
    }
    if (!isObj(courses)) {
      out.problems.push(`“${space}” is skipped: it isn’t laid out as Phaethon expects.`);
      continue;
    }
    const seen = new Map<string, Set<Part>>();
    for (const [key, parts] of sortedEntries(courses)) {
      if (!validKey(key)) {
        out.problems.push(`In “${space}”, “${key}” is skipped: it isn’t a course Phaethon knows.`);
        continue;
      }
      if (!Array.isArray(parts)) {
        out.problems.push(`In “${space}”, “${key}” is skipped: its parts should be a list.`);
        continue;
      }
      const set = new Set<Part>();
      for (const p of parts) {
        const part = parsePart(p);
        if (part) set.add(part);
        else out.problems.push(`In “${space}”, “${key}”: ${JSON.stringify(p)} isn’t a part of a course, so it’s ignored.`);
      }
      if (set.size) seen.set(key, set);
    }
    if (seen.size) out.map.set(space, seen);
  }
  return out;
}

/** The file as a JSON object, for editing; refuses a file it can't parse rather than overwrite it. */
function readDoc(): Record<string, unknown> {
  const raw = readRaw();
  if (raw === null) return {};
  try {
    const v = JSON.parse(raw);
    if (isObj(v)) return v;
  } catch {
    // fall through
  }
  throw new Refusal("course-access.json has a typing mistake, so Phaethon won’t change it. Fix it in a text editor or delete it, then try again.");
}

function writeDoc(doc: Record<string, unknown>): void {
  let root = vaultRoot();
  try {
    root = fs.realpathSync.native(root);
  } catch {
    // write() reports it
  }
  try {
    write(root, `${STATE_DIR}/${FILE}`, prettySorted(doc));
  } catch (e) {
    throw new Refusal(`Who can see your courses couldn’t be saved: ${(e as Error).message}`);
  }
}

function partsValue(parts: Set<Part>): string[] {
  return ALL_PARTS.filter((p) => parts.has(p));
}

function noSpace(space: string): Refusal {
  return new Refusal(`There’s no space called “${space}”.`);
}

function notUnderstood(space: string): Refusal {
  return new Refusal(`course-access.json has something Phaethon doesn’t understand for “${space}”, so it won’t change it. Fix it or delete it, then try again.`);
}

/** Let `space` see `parts` of `course` (an empty list: nothing). Other entries are kept as they are. */
export function set(space: string, course: string, parts: readonly Part[]): void {
  if (!spaceOk(space)) throw noSpace(space);
  if (!validKey(course)) throw new Refusal("That isn’t a course Phaethon knows.");
  // Synchronous from read to write: nothing else in the core can run in between.
  const doc = readDoc();
  const want = new Set(parts);
  if (doc[space] === undefined) doc[space] = {};
  const courses = doc[space];
  if (!isObj(courses)) throw notUnderstood(space);
  if (!want.size) delete courses[course];
  else courses[course] = partsValue(want);
  if (!Object.keys(courses).length) delete doc[space];
  writeDoc(doc);
}

/** Let each of `spaces` see every part of each of `courses` (a first import, the move to the vault). */
export function allowAll(spaces: string[], courses: string[]): void {
  if (!spaces.length || !courses.length) return;
  const doc = readDoc();
  const all = new Set(ALL_PARTS);
  for (const space of spaces) {
    if (!spaceOk(space)) throw noSpace(space);
    if (doc[space] === undefined) doc[space] = {};
    const map = doc[space];
    if (!isObj(map)) throw notUnderstood(space);
    for (const c of courses.filter(validKey)) map[c] = partsValue(all);
  }
  writeDoc(doc);
}

/** Remove every space's access to `courses`. */
export function forget(courses: string[]): void {
  const doc = readDoc();
  let changed = false;
  for (const v of Object.values(doc)) {
    if (isObj(v)) {
      for (const c of courses) {
        if (c in v) {
          delete v[c];
          changed = true;
        }
      }
    }
  }
  for (const [k, v] of Object.entries(doc)) if (isObj(v) && !Object.keys(v).length) delete doc[k];
  if (changed) writeDoc(doc);
}

// ---- What a space sees ---------------------------------------------------------

export type Seen = { key: string; connection: string; courseId: string; state: CourseState; parts: Set<Part> };

export const can = (seen: Seen, p: Part) => seen.parts.has(p);
export const seesDue = (seen: Seen) => seen.parts.has("overview") || seen.parts.has("assignments");

export type Place = { kind: "root" } | { kind: "course"; seen: Seen; dir: string; sub: string; real: string };

function byteSort(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** The courses one space may see. Build it fresh for each use, so a change in Settings applies at once. */
export class Visible {
  constructor(
    readonly vaultRoot: string,
    readonly courses: Seen[],
  ) {}

  isEmpty(): boolean {
    return this.courses.length === 0;
  }

  get(folder: string): Seen | undefined {
    return this.courses.find((c) => c.state.folder === folder);
  }

  /** A course's folder on disk, canonical, when it is still a plain folder. */
  dirOf(seen: Seen): string | null {
    const d = courseDir(this.vaultRoot, seen.state.folder);
    if (!d) return null;
    try {
      return fs.realpathSync.native(d);
    } catch {
      return null;
    }
  }

  /**
   * Resolve a lexically clean `courses/...` path. Refused, with the same words
   * whether or not the course exists, unless the space may see that course and
   * that part of it; the path must stay inside the course folder (symlinks
   * included), and the part is checked as written and as it lands on disk.
   */
  place(clean: string, mustExist: boolean): Place {
    const parts = comps(clean);
    const shown = parts.join("/");
    const hidden = () => new Refusal(`"${shown}" isn’t among the courses this space can see`);
    if (!parts.length || parts[0].toLowerCase() !== COURSES_DIR) throw hidden();
    if (parts.length === 1) return { kind: "root" };
    const seen = this.get(parts[1]);
    if (!seen) throw hidden();
    const dir = this.dirOf(seen);
    if (!dir) throw new Refusal(`"${shown}" isn’t there any more; the course may need importing again`);
    const sub = parts.slice(2).join("/");
    if (!sub) return { kind: "course", seen, dir, sub, real: dir };
    if (!seen.parts.has(partOf(sub))) throw hidden();
    let real: string;
    try {
      real = resolveIn(dir, sub, mustExist);
    } catch (e) {
      if ((e as Error).message.endsWith("does not exist")) throw new Refusal(`"${shown}" does not exist`);
      throw hidden();
    }
    const landed = path.relative(dir, real);
    if (landed.startsWith("..") || path.isAbsolute(landed)) throw hidden();
    if (landed && !seen.parts.has(partOf(landed))) throw hidden();
    return { kind: "course", seen, dir, sub, real };
  }

  /** The entries of a course folder the space may see: folders end in "/", no hidden files, sorted. */
  listCourse(seen: Seen, sub: string, real: string): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(real, { withFileTypes: true });
    } catch (e) {
      throw new Refusal(`cannot list it: ${(e as Error).message}`);
    }
    const names: string[] = [];
    for (const e of entries) {
      const name = e.name;
      if (name.startsWith(".") || !seen.parts.has(partOf(sub ? `${sub}/${name}` : name))) continue;
      names.push(e.isDirectory() ? `${name}/` : name);
    }
    return names.sort(byteSort);
  }

  /** Every file under `start` the space may see, as [path inside the course, real path], never through a link. */
  walk(seen: Seen, dir: string, start: string, max: number): [string, string][] {
    const out: [string, string][] = [];
    const stack = [start];
    while (stack.length) {
      if (out.length >= max) break;
      const p = stack.pop()!;
      let meta: fs.Stats;
      try {
        meta = fs.lstatSync(p);
      } catch {
        continue;
      }
      const rel = path.relative(dir, p).split(path.sep).join("/");
      if (rel && (path.basename(rel).startsWith(".") || !seen.parts.has(partOf(rel)))) continue;
      if (meta.isDirectory()) {
        let kids: string[] = [];
        try {
          kids = fs.readdirSync(p).map((n) => path.join(p, n));
        } catch {
          kids = [];
        }
        kids.sort(byteSort);
        stack.push(...kids.reverse());
      } else if (meta.isFile() && rel) out.push([rel, p]);
    }
    return out;
  }

  /** Folders a CLI backend may read: only courses this space sees in full. */
  cliDirs(): { label: string; path: string }[] {
    const out: { label: string; path: string }[] = [];
    for (const c of this.courses) {
      if (!ALL_PARTS.every((p) => c.parts.has(p))) continue;
      const d = this.dirOf(c);
      if (d) out.push({ label: `${COURSES_DIR}/${c.state.folder}`, path: d });
    }
    return out;
  }
}

/** What `space` may see: the vault's imported courses course-access.json lets it see, by name. */
export function visible(space: string): Visible {
  const root = vaultRoot();
  const out = new Visible(root, []);
  const mine = load().map.get(space);
  if (!mine) return out;
  let st;
  try {
    st = loadStore(root);
  } catch {
    return out;
  }
  for (const conn of st.connections) {
    for (const [cid, state] of Object.entries(conn.courses)) {
      const key = courseKey(conn.id, cid);
      const parts = mine.get(key);
      if (parts && parts.size) out.courses.push({ key, connection: conn.id, courseId: cid, state, parts: new Set(parts) });
    }
  }
  out.courses.sort((a, b) => {
    const x = a.state.name.toLowerCase();
    const y = b.state.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : byteSort(a.key, b.key);
  });
  return out;
}

/** Whether a (lexically clean) path names the courses: the first part is `courses`, in any case. */
export function isCoursesPath(clean: string): boolean {
  const parts = comps(clean);
  return parts.length > 0 && parts[0].toLowerCase() === COURSES_DIR;
}

/**
 * A course file's text as the space may see it. Only README.md mixes parts:
 * without "grades" its grades line goes; without "files" its lists of files
 * and readings go; links to other parts go when they're not allowed.
 */
export function filterText(seen: Seen, sub: string, text: string): string {
  const parts = comps(sub);
  const isReadme = parts.length === 1 && parts[0].toLowerCase() === "readme.md";
  if (!isReadme || ALL_PARTS.every((p) => seen.parts.has(p))) return text;
  const out: string[] = [];
  let skipping = false;
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.length && lines[lines.length - 1] === "" && text.endsWith("\n")) lines.pop();
  for (const line of lines) {
    const heading = line.startsWith("## ") ? line.slice(3) : line.startsWith("### ") ? line.slice(4) : null;
    if (heading !== null) {
      const h = heading.trim().toLowerCase();
      skipping = !seen.parts.has("files") && (h.startsWith("textbooks") || h === "pages" || h === "files" || h === "readings");
      if (skipping) continue;
    } else if (line.startsWith("# ")) skipping = false;
    if (skipping) continue;
    if ((line.startsWith("**Grades**") || line.startsWith("- Grades:")) && !seen.parts.has("grades")) continue;
    if (line.startsWith("- [")) {
      const r = line.slice(3);
      const at = r.indexOf("](");
      if (at >= 0) {
        const target = r.slice(at + 2).split(")")[0];
        if (!target.includes("://") && !target.includes("#") && !seen.parts.has(partOf(target))) continue;
      }
    }
    out.push(line);
  }
  let s = "";
  let blank = false;
  for (const l of out) {
    if (!l.trim()) {
      if (blank) continue;
      blank = true;
    } else blank = false;
    s += l + "\n";
  }
  return s;
}

// ---- For the UI ------------------------------------------------------------------

export type CourseInfo = {
  key: string;
  connection: string;
  courseId: string;
  name: string;
  code?: string;
  term?: string;
  folder: string;
  material?: Summary;
};

export type AccessView = {
  spaces: string[];
  courses: CourseInfo[];
  access: Record<string, Record<string, Part[]>>;
  problems: string[];
};

export function allCourses(): CourseInfo[] {
  const st = loadStore(vaultRoot());
  const out: CourseInfo[] = [];
  for (const conn of st.connections) {
    for (const [cid, c] of Object.entries(conn.courses).sort(([a], [b]) => byteSort(a, b))) {
      const info: CourseInfo = { key: courseKey(conn.id, cid), connection: conn.id, courseId: cid, name: c.name, folder: `${COURSES_DIR}/${c.folder}` };
      if (c.code !== undefined) info.code = c.code;
      if (c.term !== undefined) info.term = c.term;
      if (c.material) info.material = summarise(c.material, () => true);
      out.push(info);
    }
  }
  out.sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : byteSort(a.key, b.key);
  });
  return out;
}

/** The vault's spaces (valid ids, real folders), sorted. */
export function spaces(): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(spacesRoot()).filter(spaceOk);
  } catch {
    names = [];
  }
  return names.sort(byteSort);
}

export function view(space?: string | null): AccessView {
  if (space !== undefined && space !== null) spaceDir(space);
  const courses = allCourses();
  const known = new Set(courses.map((c) => c.key));
  const loaded = load();
  const access: Record<string, Record<string, Part[]>> = {};
  for (const [s, m] of loaded.map) {
    if (space !== undefined && space !== null && s !== space) continue;
    const entry: Record<string, Part[]> = {};
    for (const [k, p] of m) if (known.has(k)) entry[k] = ALL_PARTS.filter((x) => p.has(x));
    access[s] = entry;
  }
  return { spaces: spaces(), courses, access, problems: loaded.problems };
}

// ---- The interface other modules use ------------------------------------------------

export type VisibleCourse = { folder: string; name: string; code?: string };

/** The courses `space` may see (rebuilt on every call): folder under `courses/`, name and code. */
export function visibleCourses(space: string): VisibleCourse[] {
  return visible(space).courses.map((c) => ({ folder: c.state.folder, name: c.state.name, ...(c.state.code ? { code: c.state.code } : {}) }));
}

/** Where a `courses/...` path lands, with every check above (the course part included). */
export function placeCoursePath(space: string, rel: string, mustExist: boolean): Place {
  return visible(space).place(rel, mustExist);
}

/**
 * The real path of a visible `courses/...` file or folder for the agent's file
 * tools and file_open, or a Refusal. Plain `courses` is the vault's courses folder.
 */
export function resolveCoursePath(space: string, rel: string, mustExist: boolean): string {
  const place = placeCoursePath(space, rel, mustExist);
  return place.kind === "root" ? path.join(vaultRoot(), COURSES_DIR) : place.real;
}

/** A course file's text as `space` may see it (README.md drops parts the space can't see); other text as is. */
export function filterCourseText(space: string, rel: string, text: string): string {
  const parts = comps(rel);
  if (parts.length < 3 || parts[0].toLowerCase() !== COURSES_DIR) return text;
  const seen = visible(space).get(parts[1]);
  return seen ? filterText(seen, parts.slice(2).join("/"), text) : text;
}

/** The prompt's course index for `space`, or null when it sees no course. */
export function courseIndexForPrompt(space: string): string | null {
  const vis = visible(space);
  if (vis.isEmpty()) return null;
  let grades;
  try {
    grades = loadGrades(vis.vaultRoot);
  } catch {
    grades = { courses: {} };
  }
  return promptIndex(vis.courses, grades, nowSecs());
}

/** Course folders a CLI backend may mount: only courses `space` sees in full. */
export function fullyVisibleCourseDirs(space: string): { label: string; path: string }[] {
  return visible(space).cliDirs();
}
