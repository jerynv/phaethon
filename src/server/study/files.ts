import fs from "node:fs";
import path from "node:path";
import { charLen, isControl, splitWs, takeChars, trimEndChars, trimStartChars } from "./text.ts";

/**
 * Safe names and writes for study files, the way `lms::names` and
 * `study::mod` did them: one name part at a time, never through a symlink,
 * and every write lands by rename from a fresh temporary file.
 */

const SEGMENT_MAX = 100;

/** One path part: no separators, control or Windows-refused characters, no leading dots; never empty. */
export function segment(raw: string): string {
  let s = "";
  for (const c of raw) {
    if (isControl(c)) continue;
    s += '/\\:*?"<>|'.includes(c) ? "-" : c;
  }
  s = splitWs(s).join(" ");
  s = trimEndChars(trimStartChars(s, ". -"), ". ");
  if (charLen(s) > SEGMENT_MAX) {
    const ext = extensionOf(s);
    const extPart = ext !== null && charLen(ext) <= 10 ? `.${ext}` : "";
    const keep = SEGMENT_MAX - charLen(extPart);
    s = trimEndChars(takeChars(s, keep), ". ") + extPart;
  }
  const stem = (s.split(".")[0] ?? "").toUpperCase();
  const reserved =
    ["CON", "PRN", "AUX", "NUL"].includes(stem) ||
    ((stem.startsWith("COM") || stem.startsWith("LPT")) && stem.length === 4 && /[0-9]/.test(stem[3]!));
  if (reserved) s = "_" + s;
  return s === "" ? "untitled" : s;
}

/** Rust `Path::extension` of a file name: after the last `.`, unless the name starts with that dot or has none. */
export function extensionOf(name: string): string | null {
  const i = name.lastIndexOf(".");
  if (i <= 0) return null;
  return name.slice(i + 1);
}

class PlainError extends Error {}

function refuse(p: string): PlainError {
  return new PlainError(`${p} is not a plain folder`);
}

function isPlainRel(parts: string[]): boolean {
  return parts.length > 0 && parts.every((p) => p !== "" && p !== "." && p !== "..");
}

/** `root/rel` as a real directory, created part by part, refusing any symlink or non-folder on the way. */
export function dirIn(root: string, relParts: string[]): string {
  const meta = fs.lstatSync(root);
  if (!meta.isDirectory()) throw refuse(root);
  if (relParts.length && !isPlainRel(relParts)) throw refuse(relParts.join("/"));
  let at = root;
  for (const part of relParts) {
    at = path.join(at, part);
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(at);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (st) {
      if (!st.isDirectory()) throw refuse(at);
    } else fs.mkdirSync(at);
  }
  return at;
}

let tempCounter = 0;

/** Writes `data` to `root/rel` through a new temporary file and a rename (`names::write`). */
export function writeIn(root: string, rel: string, data: string | Uint8Array): void {
  const parts = rel.split("/").filter((p) => p !== "");
  if (!isPlainRel(parts)) throw new Error("not a plain path");
  const dir = dirIn(root, parts.slice(0, -1));
  const dest = path.join(dir, parts[parts.length - 1]!);
  let fd: number | undefined;
  let tmp = "";
  for (let n = 0; ; n++) {
    tmp = path.join(dir, `.${process.pid}.${process.hrtime.bigint()}-${tempCounter++}.part`);
    try {
      fd = fs.openSync(tmp, "wx");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST" && n < 100) continue;
      throw e;
    }
  }
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  const there = lstat(dest);
  if (there?.isDirectory()) {
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

export function lstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** `root/rel` when every part is a real folder and the last a real file (no symlink anywhere). */
export function plainFile(root: string, rel: string): string | null {
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) return null;
  let at = root;
  for (let i = 0; i < parts.length; i++) {
    at = path.join(at, parts[i]!);
    const st = lstat(at);
    if (!st) return null;
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return null;
  }
  return at;
}

/** `root/rel` when every part is a real folder (no symlink anywhere). */
export function plainDir(root: string, rel: string): string | null {
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  let at = root;
  for (const part of parts) {
    at = path.join(at, part);
    const st = lstat(at);
    if (!st?.isDirectory()) return null;
  }
  return at;
}

/** Reads at most `max` bytes, lossy UTF-8; `null` when the file is bigger. */
export function readLossyCapped(file: string, max: number): string | null {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(max + 1, Math.max(fs.fstatSync(fd).size + 1, 1)));
    let got = 0;
    for (;;) {
      if (got === buf.length) break;
      const n = fs.readSync(fd, buf, got, buf.length - got, null);
      if (n === 0) break;
      got += n;
    }
    if (got > max) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, got));
  } finally {
    fs.closeSync(fd);
  }
}

/** The text of an error as a person reads it (no stack). */
export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
