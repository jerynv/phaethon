import fs from "node:fs";
import path from "node:path";
import { cleanRel } from "../core/resolve.ts";
import { spaceDir } from "../core/vault.ts";
import { Refusal } from "../rpc/registry.ts";
import { visible, type Seen, type Visible } from "./access.ts";
import { anchor } from "./names.ts";
import { COURSES_DIR } from "./store.ts";

/**
 * A read-only map of one imported course for the course browser
 * (`lms_course_content`), built from lms.json and the folder on disk, never
 * the network. Every path is checked through `Visible.place`.
 */

export type BrowseKind = "overview" | "page" | "module" | "assignment" | "file";
export type BrowseEntry = { path: string; title: string; kind: BrowseKind; bytes?: number; anchor?: string; headingIndex?: number; text?: string };
export type CourseBrowse = { entries: BrowseEntry[]; truncated: boolean; updated?: number };

const MAX_ENTRIES = 5000;
const TITLE_BYTES = 4096;

export function courseContent(space: string, course: string): CourseBrowse {
  spaceDir(space);
  return browse(visible(space), course);
}

function byteSort(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

export function browse(vis: Visible, course: string): CourseBrowse {
  const seen = vis.courses.find((c) => c.key === course);
  if (!seen) throw new Refusal("That course isn’t among the courses this space can see.");
  const dir = vis.dirOf(seen);
  if (!dir) throw new Refusal("This course’s folder isn’t there any more; import it again.");
  const b = new Builder(vis, seen);
  for (const [rel, title] of [
    ["README.md", "Overview"],
    ["syllabus.md", "Syllabus"],
    ["announcements.md", "Announcements"],
    ["grades.md", "Grades"],
    ["links.md", "Links"],
  ] as const) {
    b.push(rel, title, "overview");
  }
  for (const [file, label, kind] of [
    ["assignments.md", "Assignments", "assignment"],
    ["modules.md", "Modules", "module"],
  ] as const) {
    if (b.push(file, label, kind)) {
      try {
        if (fs.statSync(path.join(dir, file)).size > 4 * 1024 * 1024) b.truncated = true;
      } catch {
        // checked already
      }
      headings(path.join(dir, file)).forEach(([title, anc], index) => {
        if (b.push(file, title, kind, anc)) b.entries[b.entries.length - 1].headingIndex = index;
      });
    }
  }
  const pages = vis
    .walk(seen, dir, path.join(dir, "pages"), MAX_ENTRIES)
    .filter(([rel]) => rel.endsWith(".md") && path.extname(rel) === ".md" && path.basename(rel) !== ".md")
    .map(([rel, real]) => {
      const base = path.basename(rel);
      return [rel, firstHeading(real) ?? base.slice(0, base.length - 3)] as [string, string];
    })
    .sort((a, b2) => byteSort(a[0], b2[0]) || byteSort(a[1], b2[1]));
  for (const [rel, title] of pages) b.push(rel, title, "page");
  const docs = [...new Set([...Object.values(seen.state.files).map((r) => r.path), ...Object.values(seen.state.links).flatMap((r) => (r.path !== undefined ? [r.path] : []))])].sort(byteSort);
  for (const rel of docs) b.push(rel, path.posix.basename(rel) || rel, "file");
  const out: CourseBrowse = { entries: b.entries, truncated: b.truncated };
  if (seen.state.lastSync !== undefined) out.updated = seen.state.lastSync;
  return out;
}

class Builder {
  entries: BrowseEntry[] = [];
  truncated = false;
  constructor(
    readonly vis: Visible,
    readonly seen: Seen,
  ) {}

  checked(rel: string): [string, number] | null {
    const p = `${COURSES_DIR}/${this.seen.state.folder}/${rel}`;
    try {
      const clean = cleanRel(p).join("/");
      const place = this.vis.place(clean, true);
      if (place.kind !== "course" || place.seen.key !== this.seen.key || !place.sub) return null;
      const m = fs.lstatSync(place.real);
      return m.isFile() ? [p, m.size] : null;
    } catch {
      return null;
    }
  }

  push(rel: string, title: string, kind: BrowseKind, anc?: string): boolean {
    if (this.entries.length >= MAX_ENTRIES) {
      this.truncated = true;
      return false;
    }
    const got = this.checked(rel);
    if (!got) return false;
    const e: BrowseEntry = { path: got[0], title, kind };
    if (kind === "file") e.bytes = got[1];
    if (anc !== undefined) e.anchor = anc;
    if (kind === "file") {
      const text = this.checked(`${rel}.md`);
      if (text) e.text = text[0];
    }
    this.entries.push(e);
    return true;
  }
}

function readHead(p: string, max: number): string | null {
  let fd: number;
  try {
    fd = fs.openSync(p, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, max));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    let bytes = buf.subarray(0, n);
    if (size > max) {
      const nl = bytes.lastIndexOf(0x0a);
      bytes = bytes.subarray(0, nl < 0 ? 0 : nl + 1);
    }
    return bytes.toString("utf8");
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function lines(text: string): string[] {
  const l = text.split("\n").map((x) => (x.endsWith("\r") ? x.slice(0, -1) : x));
  if (l.length && l[l.length - 1] === "") l.pop();
  return l;
}

/** A Markdown file's first `# ` heading. */
export function firstHeading(p: string): string | null {
  const text = readHead(p, TITLE_BYTES);
  if (text === null) return null;
  for (const l of lines(text)) {
    if (l.startsWith("# ")) {
      const t = l.slice(2).trim();
      return t || null;
    }
  }
  return null;
}

/** The `## ` headings with the anchors a Markdown viewer gives them (the `# ` title counts toward repeats). */
export function headings(p: string): [string, string][] {
  const text = readHead(p, 4 * 1024 * 1024);
  if (text === null) return [];
  const used = new Map<string, number>();
  const out: [string, string][] = [];
  let fence: [string, number] | null = null;
  for (const line of lines(text)) {
    const trimmed = line.trimStart();
    const ch = trimmed[0];
    if (ch === "`" || ch === "~") {
      let count = 0;
      while (trimmed[count] === ch) count++;
      if (count >= 3) {
        if (fence === null) fence = [ch, count];
        else if (fence[0] === ch && count >= fence[1]) fence = null;
        continue;
      }
    }
    if (fence) continue;
    if (line.startsWith("## ")) {
      const t = line.slice(3).trim();
      out.push([t, anchor(t, used)]);
    } else if (line.startsWith("# ")) anchor(line.slice(2).trim(), used);
  }
  return out;
}
