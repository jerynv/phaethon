import fs from "node:fs";
import path from "node:path";
import { oneLine } from "./types.ts";

/**
 * Safe file names for what a course site sends, and writing them without ever
 * leaving the course folder. Names come from the site (a file called
 * `../../.ssh/config`): each part is cleaned on its own, so the result is
 * always a plain relative path. Writes go through `dirIn`, which refuses a
 * symlink anywhere on the way, and land by rename from a temporary file.
 *
 * Relative paths here are always `/`-separated strings.
 */

/** Longest name kept for one path part, in characters. */
const SEGMENT_MAX = 100;

function isControl(c: string): boolean {
  const n = c.codePointAt(0)!;
  return n <= 0x1f || (n >= 0x7f && n <= 0x9f);
}

/** Rust `Path::file_stem` / `extension` for one file name. */
export function splitExt(name: string): { stem: string; ext: string | null } {
  if (name === "..") return { stem: name, ext: null };
  const i = name.lastIndexOf(".");
  if (i <= 0) return { stem: name, ext: null };
  return { stem: name.slice(0, i), ext: name.slice(i + 1) };
}

function trimStartChars(s: string, chars: string): string {
  let i = 0;
  while (i < s.length && chars.includes(s[i])) i++;
  return s.slice(i);
}

function trimEndChars(s: string, chars: string): string {
  let i = s.length;
  while (i > 0 && chars.includes(s[i - 1])) i--;
  return s.slice(0, i);
}

/**
 * One path part: no separators, control characters or characters Windows
 * refuses; no leading dots (no `..`, no hidden files); never empty.
 */
export function segment(raw: string): string {
  let s = "";
  for (const c of raw) {
    if (isControl(c)) continue;
    s += '/\\:*?"<>|'.includes(c) ? "-" : c;
  }
  s = oneLine(s);
  s = trimEndChars(trimStartChars(s, ". -"), ". ");
  const cps = [...s];
  if (cps.length > SEGMENT_MAX) {
    const { ext: e } = splitExt(s);
    const ext = e !== null && [...e].length <= 10 ? `.${e}` : "";
    const keep = SEGMENT_MAX - [...ext].length;
    s = trimEndChars(cps.slice(0, keep).join(""), ". ") + ext;
  }
  const stem = s.split(".")[0].replace(/[a-z]/g, (c) => c.toUpperCase());
  const reserved = ["CON", "PRN", "AUX", "NUL"].includes(stem) || ((stem.startsWith("COM") || stem.startsWith("LPT")) && stem.length === 4 && /[0-9]/.test(stem[3]));
  if (reserved) s = "_" + s;
  return s === "" ? "untitled" : s;
}

/** A site folder path ("Lectures/Week 1") and a file name as a relative path, each part cleaned. */
export function relPath(folder: string | null | undefined, name: string): string {
  const parts: string[] = [];
  for (const raw of (folder ?? "").split(/[/\\]/)) {
    const part = raw.trim();
    if (part === "" || part === "." || part === "..") continue;
    parts.push(segment(part));
  }
  parts.push(segment(name));
  return parts.join("/");
}

/** The components of a relative path as Rust would see them (empty and `.` parts dropped). */
export function components(rel: string): string[] {
  const parts = rel.split(process.platform === "win32" ? /[\\/]+/ : /\/+/);
  return parts.filter((p, i) => p !== "" && !(p === "." && i > 0));
}

/** True when `rel` is a plain relative path (only normal parts). */
export function isPlain(rel: string): boolean {
  if (rel === "" || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  const parts = rel.split(process.platform === "win32" ? /[\\/]+/ : /\/+/).filter((p) => p !== "");
  if (parts.length === 0) return false;
  return parts.every((p, i) => p !== ".." && !(p === "." && i === 0));
}

/** Paths already used in one folder tree, compared without case. */
export class Taken {
  #set = new Set<string>();
  private static key(p: string): string {
    return p.toLowerCase();
  }
  reserve(p: string): void {
    this.#set.add(Taken.key(p));
  }
  has(p: string): boolean {
    return this.#set.has(Taken.key(p));
  }
  /** `p`, or `name (2).ext`, `name (3).ext`… when it is taken. */
  claim(p: string): string {
    if (!this.#set.has(Taken.key(p))) {
      this.#set.add(Taken.key(p));
      return p;
    }
    const slash = p.lastIndexOf("/");
    const dir = slash >= 0 ? p.slice(0, slash + 1) : "";
    const { stem, ext } = splitExt(p.slice(slash + 1));
    for (let n = 2; ; n++) {
      const candidate = `${dir}${stem} (${n})${ext !== null ? `.${ext}` : ""}`;
      if (!this.#set.has(Taken.key(candidate))) {
        this.#set.add(Taken.key(candidate));
        return candidate;
      }
    }
  }
}

function lstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * `root/rel` as a real directory, created part by part. Refuses if any part on
 * the way (from `root` down) is a symlink or not a directory.
 */
export function dirIn(root: string, rel: string): string {
  const refuse = (p: string) => new Error(`${p} is not a plain folder`);
  const meta = fs.lstatSync(root);
  if (!meta.isDirectory()) throw refuse(root);
  if (rel !== "" && !isPlain(rel)) throw refuse(rel);
  let at = root;
  for (const part of components(rel)) {
    at = path.join(at, part);
    const m = lstat(at);
    if (m) {
      if (!m.isDirectory()) throw refuse(at);
    } else fs.mkdirSync(at);
  }
  return at;
}

let tempCounter = 0;

/** A new temporary file beside where `rel` will go under `root`, and the final path. */
export function tempFor(root: string, rel: string): { fd: number; tmp: string; dest: string } {
  if (!isPlain(rel)) throw new Error("not a plain path");
  const parts = components(rel);
  const name = parts.pop();
  if (!name) throw new Error("no file name");
  const dir = dirIn(root, parts.join("/"));
  const dest = path.join(dir, name);
  for (let n = 0; ; n++) {
    const tmp = path.join(dir, `.${process.pid}.${process.hrtime.bigint()}${tempCounter++}-${n}.part`);
    try {
      const fd = fs.openSync(tmp, "wx");
      return { fd, tmp, dest };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST" && n < 100) continue;
      throw e;
    }
  }
}

/** Move a finished temporary file into place. A symlink at `dest` is replaced; a folder there is refused. */
export function finish(tmp: string, dest: string): void {
  const m = lstat(dest);
  if (m?.isDirectory()) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${dest} is a folder`);
  }
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Write `bytes` to `root/rel` (temporary file, fsync, then rename). */
export function write(root: string, rel: string, bytes: string | Uint8Array): void {
  const { fd, tmp, dest } = tempFor(root, rel);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  finish(tmp, dest);
}

/** True when `p` is a plain file (not a link) whose contents are `bytes`. */
export function sameBytes(p: string, bytes: string | Uint8Array): boolean {
  const buf = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const m = lstat(p);
  if (!m?.isFile() || m.size !== buf.length) return false;
  try {
    return fs.readFileSync(p).equals(buf);
  } catch {
    return false;
  }
}

/** `write`, unless `root/rel` already holds exactly `bytes`. True when it wrote. */
export function writeIfChanged(root: string, rel: string, bytes: string | Uint8Array): boolean {
  if (sameBytes(path.join(root, rel), bytes)) return false;
  write(root, rel, bytes);
  return true;
}

/** A relative path as a Markdown link target: forward slashes; `%`, spaces, parentheses and angle brackets escaped. */
export function linkTarget(rel: string): string {
  return components(rel)
    .join("/")
    .replace(/%/g, "%25")
    .replace(/ /g, "%20")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
}

/**
 * A Markdown heading's anchor as viewers compute it: lowercase, letters,
 * digits, `-` and `_` kept, spaces become `-`, everything else dropped;
 * repeats get `-1`, `-2`… `used` counts per base.
 */
export function anchor(title: string, used: Map<string, number>): string {
  let base = "";
  for (const c of title.toLowerCase()) {
    if (/[\p{Alphabetic}\p{N}]/u.test(c) || c === "-" || c === "_") base += c;
    else if (c === " ") base += "-";
  }
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}
