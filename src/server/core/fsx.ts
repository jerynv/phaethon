import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * File helpers that match how the Rust core behaved, so files it wrote are
 * read the same way and files written now look the same to it.
 */

/** Path components, as Rust's `Path::components()` gives them for a normal path (repeated and trailing separators dropped, interior `.` dropped). */
export function components(p: string): string[] {
  const sep = process.platform === "win32" ? /[\\/]+/ : /\/+/;
  return p.split(sep).filter((c, i) => c !== "" && !(c === "." && i > 0));
}

/** Whole-component prefix test: `/a/calendar` is not inside `/a/cal`. */
export function isWithin(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** realpath(3), matching Rust's `canonicalize` on macOS and Linux. */
export function realpath(p: string): string {
  return fs.realpathSync.native(p);
}

export async function realpathAsync(p: string): Promise<string> {
  return fsp.realpath(p);
}

export function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw e;
  }
}

export function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw e;
  }
}

export function isNotFound(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Pretty JSON the way serde_json's `to_vec_pretty` wrote it (2-space indent). */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Writes a fresh temporary file beside `file` and renames it over `file`,
 * creating the parent folder. The temporary file gets a unique name (the
 * given one, or `<file>.tmp`, plus a random suffix) and is created
 * exclusively, so a link planted at that name can't redirect the write.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, options: { tmp?: string; mode?: number } = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${options.tmp ?? `${file}.tmp`}.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    const fd = fs.openSync(tmp, "wx", options.mode ?? 0o666);
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    throw e;
  }
}

export function writeJsonAtomic(file: string, value: unknown, options: { newline?: boolean; tmp?: string } = {}): void {
  writeFileAtomic(file, prettyJson(value) + (options.newline ? "\n" : ""), { tmp: options.tmp });
}

/** Reads JSON; a missing file gives `fallback`. A present but invalid file throws. */
export function readJson<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (isNotFound(e)) return fallback;
    throw e;
  }
  return JSON.parse(text) as T;
}

/** UTF-8 byte length (Rust's `str::len`). */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Unicode scalar count (Rust's `chars().count()`). */
export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** First `n` Unicode scalars (Rust's `chars().take(n)`). */
export function takeChars(s: string, n: number): string {
  let out = "";
  let i = 0;
  for (const ch of s) {
    if (i++ >= n) break;
    out += ch;
  }
  return out;
}

export function nowMs(): number {
  return Date.now();
}
