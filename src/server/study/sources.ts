import fs from "node:fs";
import path from "node:path";
import { cleanRel, resolveIn } from "../core/resolve.ts";
import { extensionOf, lstat } from "./files.ts";
import { rtrimEnd, baseName, byteLen, charLen, cmpBytes, cutBytes, isAlnum, isAlpha, rustLines, splitBy, splitWs, stableSort, stripPrefixAll, stripSuffixAll } from "./text.ts";
import { filterText, isCoursesPath, can, folderOf, type Seen, type Visible } from "./visible.ts";

/**
 * The course material a deck or quiz is made from, cut to a budget
 * (Rust `study::sources`). Budgets are UTF-8 bytes, as in Rust.
 */

/** Bytes of material sent with one request (about 15k tokens). */
export const BUDGET = 60_000;
const CHUNK = 2_500;
/** A file whose share would be smaller than this is left out. */
const MIN_SHARE = 600;
const MAX_FILES = 400;
const MAX_SENT = 40;
const READ_MAX = 4 * 1024 * 1024;
const WALK_DEPTH = 8;

export type Material = {
  /** Every source as `<source path="...">text</source>`. */
  text: string;
  /** The paths the material came from, as the model must cite them. */
  labels: string[];
  /** The course folder name, when every source is in the same course. */
  course: string | null;
};

type Found = { label: string; real: string; weight: number; course: { seen: Seen; sub: string } | null };

export function isText(p: string): boolean {
  const ext = extensionOf(path.basename(p));
  return ext !== null && ["md", "markdown", "txt"].includes(ext.replace(/[A-Z]/g, (c) => c.toLowerCase()));
}

function isIndex(rel: string): boolean {
  const name = baseName(rel).replace(/[A-Z]/g, (c) => c.toLowerCase());
  return name === "readme.md" || name === "modules.md" || name === "links.md";
}

/** "test" as a word of its own ("Test 1", "test1.pdf"), not inside another word. */
function namesTest(name: string): boolean {
  return /(^|[^\p{L}])test([^\p{L}]|$)/u.test(name);
}

function weight(rel: string, explicit: boolean, focus: string[]): number {
  const r = rel.toLowerCase();
  const name = baseName(r);
  let w: number;
  if (explicit) w = 10;
  else if (["review", "exam", "midterm", "final", "study guide", "practice"].some((k) => name.includes(k)) || namesTest(name)) w = 8;
  else if (["notes", "lecture", "slides", "chapter"].some((k) => name.includes(k))) w = 6;
  else if (r.includes("/readings/")) w = 5;
  else if (name.includes("syllabus")) w = 2;
  else if (name === "assignments.md" || name === "announcements.md") w = 1;
  else if (r.includes("/pages/") || r.includes("/files/")) w = 4;
  else w = 3;
  if (focus.some((f) => name.includes(f))) w *= 2;
  return w;
}

/** Words of the focus worth searching for. */
export function focusTerms(focus: string | null | undefined): string[] {
  const STOP = ["the", "and", "for", "with", "from", "about", "that", "this", "what", "into", "are", "how"];
  return splitBy((focus ?? "").toLowerCase(), (c) => !isAlnum(c)).filter((w) => charLen(w) >= 3 && !STOP.includes(w));
}

function relOf(root: string, p: string): string {
  const r = path.relative(root, p);
  if (r.startsWith("..") || path.isAbsolute(r)) return p.split(path.sep).filter(Boolean).join("/");
  return r.split(path.sep).filter((c) => c !== "" && c !== ".").join("/");
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `p` minus its last extension (`Path::with_extension("")`). */
function withoutExt(p: string): string {
  const ext = extensionOf(path.basename(p));
  return ext === null ? p : p.slice(0, p.length - ext.length - 1);
}

/** `x.pdf.md` beside `x.pdf` cites `x.pdf`; anything else cites itself. */
function labelFor(root: string, real: string): string {
  const rel = relOf(root, real);
  if (rel.endsWith(".md")) {
    const stem = rel.slice(0, -3);
    if (extensionOf(path.basename(stem)) !== null && isFile(withoutExt(real))) return stem;
  }
  return rel;
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > WALK_DEPTH || out.length >= MAX_FILES) return;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  names.sort(cmpBytes);
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const p = path.join(dir, name);
    const meta = lstat(p);
    if (!meta) continue;
    if (meta.isDirectory()) walk(p, depth + 1, out);
    else if (meta.isFile() && isText(p) && out.length < MAX_FILES) out.push(p);
  }
}

/** A resolved source. */
export type Source =
  | { kind: "local"; path: string }
  | { kind: "courses" }
  | { kind: "course"; seen: Seen; dir: string; sub: string; real: string };

/** Where a source `rel` (relative to the space) leads: its own files, or `courses/...` as far as the space may see. */
export function resolve(space: string, visible: Visible, rel: string): Source {
  const refused = `“${rel}” isn’t in this space.`;
  let clean: string[] | null = null;
  try {
    clean = cleanRel(rel);
  } catch {
    clean = null;
  }
  if (clean && isCoursesPath(clean)) {
    let place;
    try {
      place = visible.place(clean, true);
    } catch {
      throw refused;
    }
    if (place.kind === "root") return { kind: "courses" };
    return { kind: "course", seen: place.seen, dir: place.dir, sub: place.sub, real: place.real };
  }
  try {
    return { kind: "local", path: resolveIn(space, rel, true) };
  } catch {
    throw refused;
  }
}

/** One imported course a space can make cards from, and which standard parts it has. */
export type CourseSource = { name: string; folder: string; syllabus: boolean; assignments: boolean; files: boolean; readings: boolean };

export function courses(visible: Visible): CourseSource[] {
  const out: CourseSource[] = [];
  for (const seen of visible.courses) {
    const dir = visible.dirOf(seen);
    if (!dir) continue;
    const plain = (name: string) => {
      const m = lstat(path.join(dir, name));
      return !!m && !m.isSymbolicLink();
    };
    out.push({
      name: seen.state.name.trim() === "" ? folderOf(seen) : seen.state.name,
      folder: `courses/${folderOf(seen)}`,
      syllabus: can(seen, "syllabus") && plain("syllabus.md"),
      assignments: can(seen, "assignments") && plain("assignments.md"),
      files: can(seen, "files") && plain("files"),
      readings: can(seen, "files") && plain("readings"),
    });
  }
  return stableSort(out, (a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/** The text files of a chosen folder. */
export function folderFiles(dir: string): string[] {
  const files: string[] = [];
  walk(dir, 0, files);
  return files;
}

/** What a course file is cited as: `courses/<folder>/<path>`, the original (`x.pdf`) for a text copy. */
export function courseLabel(seen: Seen, sub: string, real: string): string {
  let rel = sub.split("/").filter((c) => c !== "").join("/");
  if (rel.endsWith(".md")) {
    const stem = rel.slice(0, -3);
    if (extensionOf(path.basename(stem)) !== null && isFile(withoutExt(real))) rel = stem;
  }
  return `courses/${folderOf(seen)}/${rel}`;
}

function noCopy(real: string): string {
  return `“${path.basename(real)}” has no text copy Phaethon can read. Import the course again, or choose its text instead.`;
}

function canonical(space: string): string {
  return fs.realpathSync.native(space);
}

function findFiles(space: string, visible: Visible, inputs: string[], focus: string[]): Found[] {
  let root: string;
  try {
    root = canonical(space);
  } catch (e) {
    throw `This space’s folder can’t be read: ${(e as Error).message}`;
  }
  const found: Found[] = [];
  const inCourse = (seen: Seen, dir: string, start: string) => {
    for (const [sub, f] of visible.walk(seen, dir, start, MAX_FILES)) {
      const label = courseLabel(seen, sub, f);
      if (isText(f) && !isIndex(label)) found.push({ weight: weight(label, false, focus), label, real: f, course: { seen, sub } });
    }
  };
  for (const input of inputs) {
    const shown = stripSuffixAll(input.trim(), "/");
    if (!shown) continue;
    const src = resolve(root, visible, shown);
    if (src.kind === "courses") {
      for (const seen of visible.courses) {
        const dir = visible.dirOf(seen);
        if (dir) inCourse(seen, dir, dir);
      }
    } else if (src.kind === "course") {
      const { seen, dir, sub, real } = src;
      if (isDir(real)) inCourse(seen, dir, real);
      else if (isText(real)) found.push({ label: courseLabel(seen, sub, real), weight: weight(shown, true, focus), real, course: { seen, sub } });
      else {
        let clean: string[];
        try {
          clean = cleanRel(`${shown}.md`);
        } catch (e) {
          throw (e as Error).message;
        }
        let copy: { real: string; sub: string } | null = null;
        try {
          const p = visible.place(clean, true);
          if (p.kind === "course" && lstat(p.real)?.isFile()) copy = { real: p.real, sub: p.sub };
        } catch {
          copy = null;
        }
        if (!copy) throw noCopy(real);
        found.push({ label: courseLabel(seen, sub, real), weight: weight(shown, true, focus), real: copy.real, course: { seen, sub: copy.sub } });
      }
    } else {
      const real = src.path;
      if (isDir(real)) {
        for (const f of folderFiles(real)) {
          const rel = relOf(root, f);
          if (!isIndex(rel) && !isCoursesPath(rel.split("/"))) found.push({ label: labelFor(root, f), weight: weight(rel, false, focus), real: f, course: null });
        }
      } else if (isText(real)) found.push({ label: labelFor(root, real), weight: weight(shown, true, focus), real, course: null });
      else {
        const copy = `${real}.md`;
        if (!lstat(copy)?.isFile()) throw noCopy(real);
        found.push({ label: relOf(root, real), weight: weight(shown, true, focus), real: copy, course: null });
      }
    }
  }
  const seenReal = new Set<string>();
  const out = found.filter((f) => (seenReal.has(f.real) ? false : (seenReal.add(f.real), true)));
  if (!out.length) throw "There’s nothing to read in what you chose: no notes, syllabus or text copies of files.";
  return out;
}

/** PDF text copies break lines after every symbol: join those fragments, drop the copy's header, squeeze spaces. */
export function clean(text: string): string {
  const out: string[] = [];
  let prevShort = false;
  rustLines(text).forEach((raw, i) => {
    if (i < 4 && (raw.startsWith("# Text of ") || raw.startsWith("Copied from ["))) return;
    const line = splitWs(raw).join(" ");
    if (line === "") {
      prevShort = false;
      if (out.length && out[out.length - 1] !== "") out.push("");
      return;
    }
    const short = charLen(line) <= 3;
    const heading = line.startsWith("#");
    const last = out[out.length - 1];
    if (last !== undefined && last !== "" && !heading && !last.startsWith("#") && (short || prevShort)) out[out.length - 1] = `${last} ${line}`;
    else out.push(line);
    prevShort = short;
  });
  return out.join("\n").trim();
}

/** The last "## Page …" line that starts before index `at`, cut at `at`. */
function pageHeadingBefore(text: string, at: number): string | null {
  const head = text.slice(0, at);
  let idx = head.length;
  while (idx >= 0) {
    const i = head.lastIndexOf("## Page ", idx);
    if (i < 0) return null;
    if (i === 0 || head[i - 1] === "\n") {
      const nl = head.indexOf("\n", i);
      let line = nl < 0 ? head.slice(i) : head.slice(i, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      return line;
    }
    idx = i - 1;
  }
  return null;
}

/** Cut text into sections of about CHUNK bytes, at paragraph breaks where it can; continuations keep their page heading. */
export function chunks(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const para of text.split("\n\n")) {
    const pb = byteLen(para);
    if (cur !== "" && curBytes + pb > CHUNK) {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    if (pb > CHUNK * 2) {
      let piece = "";
      let pieceBytes = 0;
      for (const ch of para) {
        piece += ch;
        pieceBytes += byteLen(ch);
        if (pieceBytes >= CHUNK && (ch === " " || ch === "\n")) {
          out.push(piece);
          piece = "";
          pieceBytes = 0;
        }
      }
      cur = piece;
      curBytes = pieceBytes;
      continue;
    }
    if (cur !== "") {
      cur += "\n\n";
      curBytes += 2;
    }
    cur += para;
    curBytes += pb;
  }
  if (cur.trim() !== "") out.push(cur);
  let cursor = 0;
  return out.map((part) => {
    const rel = text.indexOf(part, cursor);
    if (rel < 0) return part;
    const at = rel;
    cursor = at + part.length;
    if (part.startsWith("## Page ")) return part;
    const heading = pageHeadingBefore(text, at);
    return heading === null ? part : `${heading}\n\n${part}`;
  });
}

function countMatches(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** At most `allot` bytes of `text`: all of it when it fits, else focused or evenly spread sections, gaps marked `[…]`. */
export function sample(text: string, allot: number, focus: string[]): string {
  if (byteLen(text) <= allot) return text;
  const parts = chunks(text);
  const take = Math.min(Math.max(Math.floor(allot / CHUNK), 1), parts.length);
  const spread = () => Array.from({ length: take }, (_, i) => Math.floor((i * parts.length) / take));
  let picked: number[];
  if (!focus.length) picked = spread();
  else {
    const scored = parts.map((p, i) => {
      const lower = p.toLowerCase();
      return [focus.reduce((n, f) => n + countMatches(lower, f), 0), i] as const;
    });
    scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    const hits = scored
      .filter(([s]) => s > 0)
      .slice(0, take)
      .map(([, i]) => i);
    picked = hits.length ? hits : spread();
  }
  picked = [...new Set(picked.sort((a, b) => a - b))];
  let out = "";
  let outBytes = 0;
  let last: number | null = null;
  for (const i of picked) {
    if (last === null ? i > 0 : i > last + 1) {
      out += "\n[…]\n";
      outBytes += byteLen("\n[…]\n");
    }
    const room = Math.max(allot - outBytes, 0);
    if (room === 0) break;
    const piece = cutBytes(parts[i]!, room);
    out += piece;
    outBytes += byteLen(piece);
    last = i;
  }
  if (last !== null && last + 1 < parts.length) out += "\n[…]";
  return out;
}

function readPrefix(p: string, max: number): string {
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(Math.min(max, Math.max(fs.fstatSync(fd).size, 0)));
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, null);
      if (n === 0) break;
      got += n;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, got));
  } finally {
    fs.closeSync(fd);
  }
}

/** Read and budget the material behind `inputs` (paths in the space). */
export function gather(space: string, visible: Visible, inputs: string[], focus: string | null | undefined, budget: number): Material {
  const terms = focusTerms(focus);
  const found = stableSort(findFiles(space, visible, inputs, terms), (a, b) => b.weight - a.weight || cmpBytes(a.label, b.label)).slice(0, MAX_SENT);
  const texts: { f: Found; body: string; len: number }[] = [];
  for (const f of found) {
    let raw: string;
    try {
      raw = readPrefix(f.real, READ_MAX);
    } catch {
      continue;
    }
    if (f.course) raw = filterText(f.course.seen, f.course.sub, raw);
    const body = clean(raw);
    if (body.trim() !== "") texts.push({ f, body, len: byteLen(body) });
  }
  if (!texts.length) throw "The files you chose are empty, so there’s nothing to make cards from.";
  const allot = new Array<number>(texts.length).fill(0);
  let open = stableSort(
    texts.map((_, i) => i),
    (a, b) => texts[a]!.len - texts[b]!.len,
  );
  let left = budget;
  for (;;) {
    const w = open.reduce((s, i) => s + texts[i]!.f.weight, 0);
    const pos = open.findIndex((i) => texts[i]!.len <= (left * texts[i]!.f.weight) / w);
    if (pos < 0) break;
    const i = open.splice(pos, 1)[0]!;
    allot[i] = texts[i]!.len;
    left -= allot[i]!;
    if (!open.length) break;
  }
  const w = open.reduce((s, i) => s + texts[i]!.f.weight, 0);
  for (const i of open) allot[i] = Math.floor((left * texts[i]!.f.weight) / w);
  // A file whose share is too small is left out; its share goes to the files that are cut short.
  const skipped = texts.map((t, i) => allot[i]! < Math.min(MIN_SHARE, t.len));
  const freed = allot.reduce((s, a, i) => (skipped[i] ? s + a : s), 0);
  const takers = open.filter((i) => !skipped[i] && allot[i]! < texts[i]!.len);
  const tw = takers.reduce((s, i) => s + texts[i]!.f.weight, 0);
  if (freed > 0 && tw > 0) for (const i of takers) allot[i] = Math.min(texts[i]!.len, allot[i]! + Math.floor((freed * texts[i]!.f.weight) / tw));
  let text = "";
  const labels: string[] = [];
  texts.forEach(({ f, body }, i) => {
    if (skipped[i]) return;
    text += `<source path="${f.label}">\n${sample(body, allot[i]!, terms)}\n</source>\n\n`;
    labels.push(f.label);
  });
  if (!labels.length) throw "The files you chose are empty, so there’s nothing to make cards from.";
  const courseOfLabel = (l: string): string | null => {
    if (!l.startsWith("courses/")) return null;
    const r = l.slice(8);
    const i = r.indexOf("/");
    return i < 0 ? null : r.slice(0, i);
  };
  const first = courseOfLabel(labels[0]!);
  const course = first !== null && labels.every((l) => courseOfLabel(l) === first) ? first : null;
  return { text: trimEndWs(text), labels, course };
}

function trimEndWs(s: string): string {
  return rtrimEnd(s);
}

/** A file's text as the space may read it, by what it is cited as. */
export type Cited = { label: string; text: string };

function readText(p: string): string {
  try {
    return readPrefix(p, READ_MAX);
  } catch (e) {
    throw `it couldn’t be read: ${(e as Error).message}`;
  }
}

/** The file a citation names, read through the same walls as the material. Throws the same words whatever the reason. */
export function readCited(space: string, visible: Visible, cited: string): Cited {
  const shown = stripSuffixAll(stripPrefixAll(cited.trim(), "./"), "/");
  const refused = `“${shown}” isn’t a file this space can read`;
  if (!shown) throw refused;
  let root: string;
  try {
    root = canonical(space);
  } catch {
    throw refused;
  }
  let src: Source;
  try {
    src = resolve(root, visible, shown);
  } catch {
    throw refused;
  }
  if (src.kind === "course" && lstat(src.real)?.isFile()) {
    let copy = src.real;
    let copySub = src.sub;
    if (!isText(src.real)) {
      let clean: string[];
      try {
        clean = cleanRel(`${shown}.md`);
      } catch {
        throw refused;
      }
      let ok = false;
      try {
        const p = visible.place(clean, true);
        if (p.kind === "course" && lstat(p.real)?.isFile()) {
          copy = p.real;
          copySub = p.sub;
          ok = true;
        }
      } catch {
        ok = false;
      }
      if (!ok) throw refused;
    }
    const text = filterText(src.seen, copySub, readText(copy));
    return { label: courseLabel(src.seen, src.sub, src.real), text };
  }
  if (src.kind === "local" && lstat(src.path)?.isFile()) {
    if (isText(src.path)) return { label: labelFor(root, src.path), text: readText(src.path) };
    const copy = `${src.path}.md`;
    if (!lstat(copy)?.isFile()) throw refused;
    return { label: relOf(root, src.path), text: readText(copy) };
  }
  throw refused;
}

/** One text file of a course, as the space may see it. */
export type CourseFile = { label: string; sub: string; text: string; size: number; modified: number };

/** Every text file of `seen` the space may see (index files left out), in label order. */
export function courseFiles(visible: Visible, seen: Seen): CourseFile[] {
  const dir = visible.dirOf(seen);
  if (!dir) return [];
  const out: CourseFile[] = [];
  for (const [sub, real] of visible.walk(seen, dir, dir, MAX_FILES)) {
    const label = courseLabel(seen, sub, real);
    if (!isText(real) || isIndex(label)) continue;
    let meta: fs.Stats;
    let text: string;
    try {
      meta = fs.statSync(real);
      text = readPrefix(real, READ_MAX);
    } catch {
      continue;
    }
    out.push({ text: filterText(seen, sub, text), label, sub, size: meta.size, modified: Math.floor(meta.mtimeMs) });
  }
  return stableSort(out, (a, b) => cmpBytes(a.label, b.label));
}

/** The one course `inputs` all come from, when they name exactly one course the space sees. */
export function courseOf(space: string, visible: Visible, inputs: string[]): Seen | null {
  let root: string;
  try {
    root = canonical(space);
  } catch {
    return null;
  }
  let found: Seen | null = null;
  for (const raw of inputs) {
    const input = stripSuffixAll(raw.trim(), "/");
    if (!input) continue;
    let src: Source;
    try {
      src = resolve(root, visible, input);
    } catch {
      return null;
    }
    let seen: Seen;
    if (src.kind === "course") seen = src.seen;
    else if (src.kind === "courses" && visible.courses.length === 1) seen = visible.courses[0]!;
    else return null;
    if (found && found.key !== seen.key) return null;
    found = seen;
  }
  return found;
}

/** Lower-case words of `text` (letters only, at least two). */
export function wordsOf(text: string, into: Set<string>): void {
  for (const w of splitBy(text, (c) => !isAlpha(c))) if (charLen(w) >= 2) into.add(w.toLowerCase());
}

/** The label among `labels` a model's citation means: exact, or the one whose file name matches. */
export function matchLabel(cited: string, labels: string[]): string | null {
  const c = stripPrefixAll(cited.trim(), "./");
  const exact = labels.find((l) => l === c);
  if (exact !== undefined) return exact;
  const name = (s: string) => stripSuffixAll(baseName(s), ".md").toLowerCase();
  const n = name(c);
  const hits = labels.filter((l) => name(l) === n || l.endsWith(c));
  return hits.length === 1 ? hits[0]! : null;
}

