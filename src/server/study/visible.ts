import fs from "node:fs";
import path from "node:path";
import { resolveIn } from "../core/resolve.ts";
import { spaceDir, vaultRoot } from "../core/vault.ts";
import { segment, lstat } from "./files.ts";
import { loadStore, type CourseState } from "./lms.ts";
import { asciiLower, rustLines, trimEndChars } from "./text.ts";

/**
 * Which imported courses (and which parts of them) a space may see, the way
 * `lms::access` decided it. Study reads courses only through this.
 *
 * NOTE for the integrator: this is a read-only mirror of the LMS worker's
 * `src/server/lms/access.ts` (course-access.json + lms.json, `place`, `walk`,
 * `filter_text`). Once that module lands, `visibleFor` can delegate to it as
 * long as it returns objects with this shape.
 */

export const PARTS = ["overview", "syllabus", "assignments", "announcements", "files", "grades"] as const;
export type Part = (typeof PARTS)[number];

export type Seen = {
  key: string;
  connection: string;
  courseId: string;
  state: CourseState;
  parts: Set<Part>;
};

export const can = (seen: Seen, p: Part): boolean => seen.parts.has(p);
export const folderOf = (seen: Seen): string => seen.state.folder;
export const seesDue = (seen: Seen): boolean => can(seen, "overview") || can(seen, "assignments");

/** The part a path inside a course folder belongs to, by its first component. */
export function partOf(sub: string): Part {
  const comps = sub.split("/").filter((c) => c !== "" && c !== ".");
  if (!comps.length) return "overview";
  const name = trimEndChars(comps[0]!.toLowerCase(), ". ");
  const only = comps.length === 1;
  if (name === "readme.md" && only) return "overview";
  if (name === "syllabus.md") return "syllabus";
  if (name === "assignments.md") return "assignments";
  if (name === "announcements.md") return "announcements";
  if (name === "grades.md") return "grades";
  return "files";
}

export const isCoursesPath = (clean: string[]): boolean => clean.length > 0 && asciiLower(clean[0]!) === "courses";

export type Place =
  | { kind: "root" }
  | { kind: "course"; seen: Seen; dir: string; sub: string; real: string };

const MAX_ACCESS = 1024 * 1024;

function validKey(key: string): boolean {
  const i = key.indexOf("/");
  if (i < 0) return false;
  const conn = key.slice(0, i);
  const course = key.slice(i + 1);
  const plain = (s: string, extra: string) =>
    s.length > 0 && Buffer.byteLength(s) <= 128 && [...s].every((c) => /[A-Za-z0-9-]/.test(c) || extra.includes(c));
  return plain(conn, "") && plain(course, "_.:");
}

/** Parts per course key for one space (course-access.json); any problem → nothing. */
function accessFor(root: string, space: string): Map<string, Set<Part>> {
  const out = new Map<string, Set<Part>>();
  const file = path.join(root, ".phaethon", "course-access.json");
  const st = lstat(file);
  if (!st || !st.isFile() || st.size > MAX_ACCESS) return out;
  let top: unknown;
  try {
    top = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return out;
  }
  if (!top || typeof top !== "object" || Array.isArray(top)) return out;
  const mine = (top as Record<string, unknown>)[space];
  if (!mine || typeof mine !== "object" || Array.isArray(mine)) return out;
  for (const [key, parts] of Object.entries(mine as Record<string, unknown>)) {
    if (!validKey(key) || !Array.isArray(parts)) continue;
    const set = new Set<Part>();
    for (const p of parts) if (typeof p === "string" && (PARTS as readonly string[]).includes(p)) set.add(p as Part);
    if (set.size) out.set(key, set);
  }
  return out;
}

export class Visible {
  constructor(
    readonly vaultRoot: string,
    readonly courses: Seen[],
  ) {}

  isEmpty(): boolean {
    return this.courses.length === 0;
  }

  /** Exact, case-sensitive match on the course folder. */
  get(folder: string): Seen | undefined {
    return this.courses.find((c) => c.state.folder === folder);
  }

  /** The course's folder on disk, canonical, when it's still a plain folder. */
  dirOf(seen: Seen): string | null {
    const root = path.join(this.vaultRoot, "courses");
    const dir = path.join(root, seen.state.folder);
    if (segment(seen.state.folder) !== seen.state.folder) return null;
    if (!lstat(root)?.isDirectory() || !lstat(dir)?.isDirectory()) return null;
    try {
      return fs.realpathSync.native(dir);
    } catch {
      return null;
    }
  }

  /** Resolves a lexically clean `courses/...` path (components), as `Visible::place`. */
  place(clean: string[], mustExist: boolean): Place {
    const shown = clean.join("/");
    const hidden = () => `"${shown}" isn’t among the courses this space can see`;
    if (!clean.length || asciiLower(clean[0]!) !== "courses") throw hidden();
    if (clean.length === 1) return { kind: "root" };
    const seen = this.get(clean[1]!);
    if (!seen) throw hidden();
    const dir = this.dirOf(seen);
    if (!dir) throw `"${shown}" isn’t there any more; the course may need importing again`;
    const sub = clean.slice(2).join("/");
    if (!sub) return { kind: "course", seen, dir, sub: "", real: dir };
    if (!can(seen, partOf(sub))) throw hidden();
    let real: string;
    try {
      real = resolveIn(dir, sub, mustExist);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw m.endsWith("does not exist") ? `"${shown}" does not exist` : hidden();
    }
    const landed = path.relative(dir, real);
    if (landed.startsWith("..") || path.isAbsolute(landed)) throw hidden();
    const landedRel = landed.split(path.sep).join("/");
    if (landedRel !== "" && !can(seen, partOf(landedRel))) throw hidden();
    return { kind: "course", seen, dir, sub, real };
  }

  /** Every visible file under `start` (no links followed, dot-names skipped), as [sub, real]; at most `max`. */
  walk(seen: Seen, dir: string, start: string, max: number): [string, string][] {
    const out: [string, string][] = [];
    const stack = [start];
    while (stack.length) {
      if (out.length >= max) break;
      const p = stack.pop()!;
      const meta = lstat(p);
      if (!meta) continue;
      const relRaw = path.relative(dir, p);
      const rel = relRaw.startsWith("..") ? "" : relRaw.split(path.sep).join("/");
      if (rel !== "" && (path.basename(rel).startsWith(".") || !can(seen, partOf(rel)))) continue;
      if (meta.isDirectory()) {
        let kids: string[] = [];
        try {
          kids = fs.readdirSync(p).map((n) => path.join(p, n));
        } catch {
          continue;
        }
        kids.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
        stack.push(...kids.reverse());
      } else if (meta.isFile() && rel !== "") out.push([rel, p]);
    }
    return out;
  }

  /** Only fully visible courses, as [label, real dir]. */
  cliDirs(): [string, string][] {
    const out: [string, string][] = [];
    for (const c of this.courses) {
      if (!PARTS.every((p) => can(c, p))) continue;
      const d = this.dirOf(c);
      if (d) out.push([`courses/${c.state.folder}`, d]);
    }
    return out;
  }
}

/** What `space` may see: imported courses course-access.json allows, sorted by name then key. */
export function visibleFor(space: string): Visible {
  const root = vaultRoot();
  spaceDir(space);
  const mine = accessFor(root, space);
  const courses: Seen[] = [];
  if (mine.size) {
    let store;
    try {
      store = loadStore(root);
    } catch {
      store = { connections: [] };
    }
    for (const conn of store.connections) {
      for (const [cid, state] of Object.entries(conn.courses ?? {})) {
        const key = `${conn.id}/${cid}`;
        const parts = mine.get(key);
        if (parts?.size) courses.push({ key, connection: conn.id, courseId: cid, state, parts: new Set(parts) });
      }
    }
  }
  courses.sort((a, b) => {
    const x = a.state.name.toLowerCase();
    const y = b.state.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return new Visible(root, courses);
}

/** A course file's text as the space may see it (only a top-level README.md mixes parts). */
export function filterText(seen: Seen, sub: string, text: string): string {
  const comps = sub.split("/").filter((c) => c !== "");
  const isReadme = comps.length === 1 && asciiLower(sub) === "readme.md";
  if (!isReadme || PARTS.every((p) => can(seen, p))) return text;
  const out: string[] = [];
  let skipping = false;
  for (const line of rustLines(text)) {
    const h = line.startsWith("## ") ? line.slice(3) : line.startsWith("### ") ? line.slice(4) : null;
    if (h !== null) {
      const hh = h.trim().toLowerCase();
      skipping = !can(seen, "files") && (hh.startsWith("textbooks") || ["pages", "files", "readings"].includes(hh));
      if (skipping) continue;
    } else if (line.startsWith("# ")) skipping = false;
    if (skipping) continue;
    if (line.startsWith("**Grades**") && !can(seen, "grades")) continue;
    if (line.startsWith("- Grades:") && !can(seen, "grades")) continue;
    if (line.startsWith("- [")) {
      const r = line.slice(3);
      const i = r.indexOf("](");
      if (i >= 0) {
        const target = r.slice(i + 2).split(")")[0] ?? "";
        if (!target.includes("://") && !target.includes("#") && !can(seen, partOf(target))) continue;
      }
    }
    out.push(line);
  }
  let s = "";
  let blank = false;
  for (const l of out) {
    if (l.trim() === "") {
      if (blank) continue;
      blank = true;
    } else blank = false;
    s += l + "\n";
  }
  return s;
}
