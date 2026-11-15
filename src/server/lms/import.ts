import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileHexAsync } from "./hash.ts";
import { pageTitle, scan, toMarkdown, type FoundLink } from "./html.ts";
import type { HttpResponse } from "./http.ts";
import { assessCourse, type Report } from "./material.ts";
import { anchor, dirIn, finish, isPlain, linkTarget, relPath, segment, Taken, tempFor, write, writeIfChanged } from "./names.ts";
import { MAX_DOWNLOAD, type Session } from "./session.ts";
import { displayTime, gradeWords, nowMs, nowSecs, num, parseTime, type CourseState, type Due, type FileRec, type LinkRec } from "./store.ts";
import { copyIsStale, extract, kindOf, pdfLayers } from "./text/index.ts";
import { isbns as findIsbns, isTextbook, pdfLinkOnPage, type Isbn } from "./textbooks.ts";
import { CANCELLED, isCancelled, isLmsError, oneLine, rustTrim, type Assignment, type Course, type CourseContent, type CourseGrades, type GradeItem, type LmsError, type RemoteFile } from "./types.ts";
import { urlDecode } from "./csrf.ts";

/**
 * Writing one course into the vault as plain files: Markdown for the syllabus,
 * assignments, announcements, modules and pages; the course's files downloaded
 * with the session; documents the course links to downloaded without it into
 * readings/; a text copy beside every PDF, Office file and picture; and a
 * README that says what's coming up, which textbooks the course uses and where
 * each one is. Everything lands under `<vault>/courses/<course>/` through
 * names.ts, which never follows a symlink. A re-import keeps the same folder
 * and downloads only what changed.
 */

export type Options = {
  maxDownload: number;
  maxLinks: number;
  /** The course's grades, read just before; null keeps any grades.md already there. */
  grades: CourseGrades | null;
  /** The person's Cancel. */
  signal: AbortSignal;
};

export function defaultOptions(signal: AbortSignal = new AbortController().signal): Options {
  return { maxDownload: MAX_DOWNLOAD, maxLinks: 80, grades: null, signal };
}

export type Outcome = {
  state: CourseState;
  files: number;
  downloaded: number;
  unchanged: number;
  cancelled: boolean;
  /** The Markdown and README were written. */
  written: boolean;
  readings: number;
  links: number;
  skipped: string[];
};

export type Step = "files" | "readings" | "writing";
export type Progress = (step: Step, done: number, total: number) => void;

const README = "README.md";
const GRADES_MD = "grades.md";
const README_STAMP = "Imported from ";
const GRADES_STAMP = "Read from the course site on ";
const FIXED = [README, GRADES_MD, "syllabus.md", "assignments.md", "announcements.md", "modules.md", "links.md", "pages", "files", "readings"];
const MAX_PAGE = 2 * 1024 * 1024;
const INDEX_LIST_MAX = 200;
export const NO_TEXT_COPY = "(This file has no text in it: it may be scanned pages or pictures. Open the file itself to read it.)";

/** A file's identity on the site: its address without query or fragment. */
export function fileKey(u: URL): string {
  const c = new URL(u.href);
  c.search = "";
  c.hash = "";
  return c.href;
}

/** For matching links in course HTML: also without a trailing slash and a trailing `/download` or `/preview`. */
export function linkKey(u: URL): string {
  const k = fileKey(u).replace(/\/+$/, "");
  if (k.endsWith("/download")) return k.slice(0, -9);
  if (k.endsWith("/preview")) return k.slice(0, -8);
  return k;
}

export function mb(bytes: number): string {
  const K = 1024;
  if (bytes < K * K) return `${Math.max(1, Math.ceil(bytes / K))} KB`;
  if (bytes < K * K * K) return `${Math.round(bytes / K / K)} MB`;
  return `${(bytes / K / K / K).toFixed(1)} GB`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const noBrackets = (s: string) => s.replace(/[[\]]/g, "");

function lines(text: string): string[] {
  const l = text.split("\n").map((x) => (x.endsWith("\r") ? x.slice(0, -1) : x));
  if (l.length && l[l.length - 1] === "") l.pop();
  return l;
}

function pickFolder(course: Course, prev: CourseState | undefined, taken: string[]): string {
  if (prev && segment(prev.folder) === prev.folder) return prev.folder;
  const used = new Set(taken.map((t) => t.toLowerCase()));
  const base = segment(course.name);
  const candidates = [base];
  if (course.code) candidates.push(segment(`${course.name} (${course.code})`));
  const free = candidates.find((c) => !used.has(c.toLowerCase()));
  if (free) return free;
  for (let n = 2; ; n++) {
    const c = `${base} (${n})`;
    if (!used.has(c.toLowerCase())) return c;
  }
}

function header(res: HttpResponse, name: string): string | null {
  const v = res.header(name);
  if (v === undefined) return null;
  const t = v.trim();
  return t && Buffer.byteLength(t) < 512 ? t : null;
}

function dispositionName(res: HttpResponse): string | null {
  const v = header(res, "content-disposition");
  if (!v) return null;
  const parts = v.split(";").map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith("filename*=")) {
      const n = part.slice(10);
      const i = n.lastIndexOf("''");
      return urlDecode((i >= 0 ? n.slice(i + 2) : n).replace(/^"+|"+$/g, ""));
    }
  }
  const f = parts.find((p) => p.startsWith("filename="));
  return f ? f.slice(9).replace(/^"+|"+$/g, "") : null;
}

function startsWith(b: Buffer, sig: number[] | string): boolean {
  const s = typeof sig === "string" ? Buffer.from(sig, "latin1") : Buffer.from(sig);
  return b.length >= s.length && b.subarray(0, s.length).equals(s);
}

/** The document type of a download from its first bytes, content type and name. */
export function sniff(first: Buffer, contentType: string, nameExt: string): string | null {
  const ct = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (startsWith(first, "%PDF-")) return "pdf";
  const by = (pairs: [string, string][]) => pairs.find(([ext, mime]) => nameExt === ext || ct === mime)?.[0] ?? null;
  if (startsWith(first, "PK\x03\x04")) {
    return by([
      ["epub", "application/epub+zip"],
      ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
      ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["odt", "application/vnd.oasis.opendocument.text"],
      ["odp", "application/vnd.oasis.opendocument.presentation"],
    ]);
  }
  if (startsWith(first, [0xd0, 0xcf, 0x11, 0xe0])) {
    return by([
      ["doc", "application/msword"],
      ["ppt", "application/vnd.ms-powerpoint"],
      ["xls", "application/vnd.ms-excel"],
    ]);
  }
  if (startsWith(first, "{\\rtf")) return "rtf";
  return null;
}

function looksHtml(first: Buffer, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.startsWith("text/html") || ct.startsWith("application/xhtml")) return true;
  const start = first.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return start.startsWith("<!doctype html") || start.startsWith("<html");
}

function extOf(name: string): string {
  const base = name.split("/").pop() ?? name;
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** Reads a response body chunk by chunk. */
class Body {
  #it: AsyncIterator<Buffer>;
  constructor(res: HttpResponse) {
    this.#it = res.chunks()[Symbol.asyncIterator]();
  }
  async next(): Promise<Buffer | null> {
    const r = await this.#it.next();
    return r.done ? null : r.value;
  }
  /** At least `n` bytes (or the end). */
  async head(n: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let size = 0;
    while (size < n) {
      const c = await this.next();
      if (!c) break;
      parts.push(c);
      size += c.length;
    }
    return Buffer.concat(parts);
  }
  close(): void {
    void this.#it.return?.();
  }
}

/** Writes `first` and the rest of `body` to `fd`, at most `cap` bytes, hashing as it goes. */
async function restTo(body: Body, first: Buffer, fd: number, cap: number, hash: ReturnType<typeof createHash> | null): Promise<number> {
  const tooBig = () => new Error(`it is bigger than the ${mb(cap)} limit`);
  let total = first.length;
  if (total > cap) throw tooBig();
  fs.writeSync(fd, first);
  hash?.update(first);
  for (;;) {
    let chunk: Buffer | null;
    try {
      chunk = await body.next();
    } catch (e) {
      if (isCancelled(e)) throw e;
      throw new Error(`the download stopped: ${(e as Error).message}`);
    }
    if (!chunk) break;
    total += chunk.length;
    if (total > cap) {
      body.close();
      throw tooBig();
    }
    fs.writeSync(fd, chunk);
    hash?.update(chunk);
  }
  return total;
}

type Fetched = { kind: "saved"; tmp: string; name: string; via: URL | null; title: string | null } | { kind: "page"; title: string | null } | { kind: "failed"; note: string };

function whyNot(e: unknown): string {
  if (isLmsError(e, "network")) return "couldn’t be reached";
  const m = (e as Error).message ?? String(e);
  if (isLmsError(e, "other") && (m.includes("(401)") || m.includes("(403)"))) return "needs a sign-in (the publisher’s or the library’s), so Phaethon couldn’t download it";
  if (isLmsError(e, "other") && (m.includes("(404)") || m.includes("(410)"))) return "the link is broken (the page isn’t there)";
  return `couldn’t be downloaded: ${m}`;
}

async function saveTmp(dir: string, body: Body, first: Buffer, cap: number, temps: Set<string>): Promise<string> {
  let t;
  try {
    t = tempFor(dir, "download");
  } catch (e) {
    throw new Error(`couldn’t be saved: ${(e as Error).message}`);
  }
  temps.add(t.tmp);
  try {
    await restTo(body, first, t.fd, cap, null);
  } catch (e) {
    fs.closeSync(t.fd);
    fs.rmSync(t.tmp, { force: true });
    temps.delete(t.tmp);
    throw e;
  }
  fs.closeSync(t.fd);
  return t.tmp;
}

/**
 * Fetch a link out of the course without the session. A document is saved
 * into `readingsDir` under a temporary name; a web page gives its title, and
 * for a textbook its page is searched (one level, no further) for the book's PDF.
 */
async function fetchLink(session: Session, readingsDir: string, url: URL, textbook: boolean, cap: number, temps: Set<string>): Promise<Fetched> {
  let res: HttpResponse;
  try {
    res = await session.fetchExternal(url);
  } catch (e) {
    if (isCancelled(e)) throw e;
    return { kind: "failed", note: whyNot(e) };
  }
  const finalUrl = res.url;
  const ct = header(res, "content-type") ?? "";
  const dname = dispositionName(res);
  const len = res.contentLength();
  if (len !== null && len > cap && !ct.toLowerCase().startsWith("text/html")) {
    res.discard();
    return { kind: "failed", note: `is bigger than the ${mb(cap)} limit` };
  }
  const body = new Body(res);
  let first: Buffer;
  try {
    first = await body.head(1024);
  } catch (e) {
    if (isCancelled(e)) throw e;
    return { kind: "failed", note: `couldn’t be downloaded: ${(e as Error).message}` };
  }
  const lastSeg = finalUrl.pathname.split("/").pop() ?? "";
  const baseName = dname ?? (lastSeg ? urlDecode(lastSeg) : "") ?? "";
  const name0 = baseName || "reading";
  const ext = sniff(first, ct, extOf(name0));
  if (ext) {
    const name = extOf(name0) === ext ? name0 : `${name0}.${ext}`;
    try {
      const tmp = await saveTmp(readingsDir, body, first, cap, temps);
      return { kind: "saved", tmp, name, via: null, title: null };
    } catch (e) {
      if (isCancelled(e)) throw e;
      return { kind: "failed", note: (e as Error).message };
    }
  }
  if (!looksHtml(first, ct)) {
    body.close();
    const what = (ct.split(";")[0] ?? "").trim();
    return { kind: "failed", note: what ? `isn’t a document Phaethon saves (${what})` : "isn’t a document Phaethon saves" };
  }
  const parts = [first];
  let size = first.length;
  while (size < MAX_PAGE) {
    let c: Buffer | null = null;
    try {
      c = await body.next();
    } catch (e) {
      if (isCancelled(e)) throw e;
      c = null;
    }
    if (!c) break;
    parts.push(c);
    size += c.length;
  }
  body.close();
  const page = Buffer.concat(parts).toString("utf8");
  const title = pageTitle(page);
  if (textbook) {
    const pdf = pdfLinkOnPage(page, finalUrl);
    if (pdf && pdf.href !== url.href && pdf.href !== finalUrl.href) {
      try {
        const r2 = await session.fetchExternal(pdf);
        const ct2 = header(r2, "content-type") ?? "";
        const d2 = dispositionName(r2);
        const b2 = new Body(r2);
        const f2 = await b2.head(1024);
        if (sniff(f2, ct2, "pdf") === "pdf") {
          const tmp = await saveTmp(readingsDir, b2, f2, cap, temps);
          const seg = pdf.pathname.split("/").pop() ?? "";
          let name = d2 ?? (title !== null ? `${title}.pdf` : null) ?? (seg !== "" ? seg : null) ?? "textbook.pdf";
          if (extOf(name) !== "pdf") name = `${name}.pdf`;
          return { kind: "saved", tmp, name, via: finalUrl, title };
        }
        b2.close();
      } catch (e) {
        if (isCancelled(e)) throw e;
      }
    }
  }
  return { kind: "page", title };
}

/** A text copy (`name.ext.md`) beside a document, written only when it differs. */
async function textCopy(root: string, rel: string, signal: AbortSignal): Promise<void> {
  if (kindOf(rel) === "other") return;
  if (signal.aborted) throw new Error(CANCELLED);
  const name = rel.split("/").pop() ?? rel;
  let extracted: string;
  try {
    extracted = await extract(path.join(root, rel), signal);
  } catch (e) {
    if (signal.aborted) throw new Error(CANCELLED);
    throw new Error(`${name}: no text copy (${(e as Error).message})`);
  }
  if (signal.aborted) throw new Error(CANCELLED);
  const body = rustTrim(extracted) ? extracted : NO_TEXT_COPY;
  const doc = `# Text of ${name}\n\nCopied from [${name}](${linkTarget(name)}) so it can be read here. Layout, pictures and equations may be missing; the file itself is the original.\n\n${body}\n`;
  try {
    writeIfChanged(root, `${rel}.md`, doc);
  } catch (e) {
    throw new Error(`${name}: no text copy (${(e as Error).message})`);
  }
}

export type Got = { kind: "same"; rec: FileRec } | { kind: "written"; rec: FileRec } | { kind: "skipped"; why: string } | { kind: "cancelled" };

function downloadError(name: string, e: LmsError | Error): string {
  if (isLmsError(e, "signedOut")) return `${name}: couldn’t be downloaded (sign in again if this keeps happening)`;
  if (isLmsError(e, "forbidden")) return `${name}: the course site didn’t allow downloading it`;
  if (isLmsError(e, "notFound")) return `${name}: the course site couldn’t find it`;
  return `${name}: couldn’t be downloaded (${e.message})`;
}

/**
 * Bring one course file up to date at `root/rel`, doing as little as the site
 * allows: only a copy verified against its saved SHA-256 may use the listing's
 * version or HTTP validators; otherwise the body is read while hashed, and only
 * different bytes replace the file on disk.
 */
export async function fetchFile(session: Session, root: string, f: RemoteFile, rel: string, old: FileRec | undefined, opts: Options): Promise<Got> {
  const dest = path.join(root, rel);
  let verified: FileRec | undefined;
  if (old && old.path === rel && old.sha256 !== undefined && (await fileHexAsync(dest)) === old.sha256) verified = old;
  if (verified && f.version !== null && verified.version === f.version && (f.size === null || f.size === verified.size)) return { kind: "same", rec: { ...verified } };
  let res: HttpResponse;
  try {
    res = await session.getConditional(f.url, verified?.etag ?? null, verified?.modified ?? null);
  } catch (e) {
    if (isCancelled(e) || opts.signal.aborted) return { kind: "cancelled" };
    return { kind: "skipped", why: downloadError(f.name, e as Error) };
  }
  const etag = header(res, "etag") ?? undefined;
  const modified = header(res, "last-modified") ?? undefined;
  const withVersion = (r: FileRec): FileRec => {
    const out = { ...r };
    if (f.version !== null) out.version = f.version;
    else delete out.version;
    return out;
  };
  if (res.status === 304) {
    res.discard();
    if (!verified) return { kind: "skipped", why: `${f.name}: the course site sent no file` };
    return { kind: "same", rec: withVersion({ ...verified, etag: etag ?? verified.etag, modified: modified ?? verified.modified }) };
  }
  // An expired session can redirect a binary download to an HTTP-200 login
  // page. Keep the previous file rather than saving that page as the document.
  const isHtml = (mime: string | null | undefined) => /^(?:text\/html|application\/xhtml\+xml)$/i.test((mime ?? "").split(";", 1)[0].trim());
  const binary = /\.(?:pdf|docx?|pptx?|xlsx?|zip|gz|7z|png|jpe?g|gif|bmp|webp|tiff?)$/i.test(f.name)
    || /^(?:application\/(?:pdf|zip|gzip|msword|vnd\.)|image\/|audio\/|video\/)/i.test(f.mime ?? "");
  if (isHtml(header(res, "content-type")) && (binary || !!f.mime) && !isHtml(f.mime) && !/\.x?html?$/i.test(f.name)) {
    res.discard();
    return { kind: "skipped", why: `${f.name}: the course site sent a webpage instead of the file (sign in again if this keeps happening)` };
  }
  const listed = f.size ?? res.contentLength();
  if (verified && (etag !== undefined || modified !== undefined) && verified.etag === etag && verified.modified === modified && (listed === null || verified.size === listed)) {
    res.discard();
    return { kind: "same", rec: withVersion(verified) };
  }
  const len = res.contentLength();
  if (len !== null && len > opts.maxDownload) {
    res.discard();
    return { kind: "skipped", why: `${f.name}: too big to download (${mb(len)}; the limit is ${mb(opts.maxDownload)})` };
  }
  let t;
  try {
    t = tempFor(root, rel);
  } catch (e) {
    res.discard();
    return { kind: "skipped", why: `${f.name}: couldn’t be saved (${(e as Error).message})` };
  }
  const hash = createHash("sha256");
  let n: number;
  try {
    n = await restTo(new Body(res), Buffer.alloc(0), t.fd, opts.maxDownload, hash);
  } catch (e) {
    fs.closeSync(t.fd);
    fs.rmSync(t.tmp, { force: true });
    if (isCancelled(e) || opts.signal.aborted) return { kind: "cancelled" };
    return { kind: "skipped", why: `${f.name}: ${(e as Error).message}` };
  }
  fs.closeSync(t.fd);
  const sha = hash.digest("hex");
  const rec: FileRec = { path: rel, size: n, etag, modified, sha256: sha };
  if (f.version !== null) rec.version = f.version;
  if ((await fileHexAsync(t.dest)) === sha) {
    fs.rmSync(t.tmp, { force: true });
    return { kind: "same", rec };
  }
  try {
    finish(t.tmp, t.dest);
  } catch (e) {
    return { kind: "skipped", why: `${f.name}: couldn’t be saved (${(e as Error).message})` };
  }
  return { kind: "written", rec };
}

/** Write `body` unless the file already says the same apart from lines starting with `stamp`. */
function writeUnlessSame(root: string, rel: string, body: string, stamp: string | null): boolean {
  const p = path.join(root, rel);
  if (stamp !== null) {
    try {
      if (fs.lstatSync(p).isFile()) {
        const old = fs.readFileSync(p, "utf8");
        const strip = (t: string) => lines(t).filter((l) => !l.startsWith(stamp));
        const a = strip(old);
        const b = strip(body);
        if (a.length === b.length && a.every((x, i) => x === b[i])) return false;
      }
    } catch {
      // write it
    }
  }
  try {
    return writeIfChanged(root, rel, body);
  } catch (e) {
    throw new Error(`${rel} couldn’t be written: ${(e as Error).message}`);
  }
}

type Targets = { local: Map<string, string>; readings: Map<string, string> };

function rewrite(targets: Targets, session: Session, u: URL, depth: number): string {
  const up = "../".repeat(depth);
  if (session.site.owns(u)) {
    const rel = targets.local.get(linkKey(u));
    if (rel !== undefined) {
      const i = rel.indexOf("#");
      const p = i >= 0 ? rel.slice(0, i) : rel;
      return `${up}${linkTarget(p)}${i >= 0 ? rel.slice(i) : ""}`;
    }
  } else {
    const rel = targets.readings.get(linkKey(u));
    if (rel !== undefined) return `${up}${linkTarget(rel)}`;
  }
  return u.href;
}

type LinkSeen = { found: FoundLink; textbook: boolean; from: string };
type Planned = { a: Assignment; anchor: string; t: number | null };

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Runs `tasks` at most `limit` at a time, handing each result over as it finishes. */
async function* unordered<T>(tasks: (() => Promise<T>)[], limit: number): AsyncGenerator<T> {
  const running = new Map<number, Promise<[number, T]>>();
  let next = 0;
  const start = () => {
    const i = next++;
    running.set(
      i,
      tasks[i]().then((v) => [i, v] as [number, T]),
    );
  };
  while (next < tasks.length && running.size < limit) start();
  while (running.size) {
    const [i, v] = await Promise.race(running.values());
    running.delete(i);
    if (next < tasks.length) start();
    yield v;
  }
}

export async function importCourse(
  session: Session,
  coursesRoot: string,
  course: Course,
  content: CourseContent,
  prev: CourseState | undefined,
  otherFolders: string[],
  opts: Options,
  progress: Progress,
): Promise<Outcome> {
  const signal = opts.signal;
  const folder = pickFolder(course, prev, otherFolders);
  let root: string;
  try {
    root = dirIn(coursesRoot, folder);
  } catch (e) {
    throw new Error(`The folder for ${course.name} couldn’t be made: ${(e as Error).message}`);
  }
  const skipped = [...content.skipped];
  const taken = new Taken();
  for (const f of FIXED) taken.reserve(f);

  // ---- Plan where everything goes, so links can be rewritten. ----
  const prevFiles = prev?.files ?? {};
  const kept = (key: string): string | null => {
    const r = prevFiles[key];
    if (!r) return null;
    return isPlain(r.path) && r.path.split("/")[0] === "files" ? r.path : null;
  };
  for (const f of content.files) {
    const p = kept(fileKey(f.url));
    if (p) taken.reserve(p);
  }
  const seenKeys = new Set<string>();
  const planned: string[] = [];
  for (const f of content.files) {
    const key = fileKey(f.url);
    const k = kept(key);
    let p: string;
    if (k !== null && !seenKeys.has(key)) {
      seenKeys.add(key);
      p = k;
    } else p = taken.claim(`files/${relPath(f.folder, f.name)}`);
    taken.reserve(`${p}.md`);
    planned.push(p);
  }
  const local = new Map<string, string>();
  content.files.forEach((f, i) => {
    for (const u of [f.url, ...f.aliases]) if (!local.has(linkKey(u))) local.set(linkKey(u), planned[i]);
  });
  const pagePaths: string[] = [];
  for (const p of content.pages) {
    const rel = taken.claim(`pages/${segment(p.title)}.md`);
    if (p.url && !local.has(linkKey(p.url))) local.set(linkKey(p.url), rel);
    pagePaths.push(rel);
  }
  // Anchors in the order the headings are written (due date order), from the
  // heading text as written, with the file's own title counted: what viewers compute.
  const withTimes = content.assignments.map((a) => ({ a, t: a.due !== null ? parseTime(a.due) : null }));
  const sorted = withTimes
    .map((x, i) => ({ ...x, i }))
    .sort((x, y) => (x.t === null ? 1 : 0) - (y.t === null ? 1 : 0) || (x.t ?? 0) - (y.t ?? 0) || x.i - y.i);
  const anchorsUsed = new Map<string, number>();
  anchor(`Assignments: ${course.name}`.trim(), anchorsUsed);
  const assignments: Planned[] = sorted.map(({ a, t }) => ({ a, t, anchor: anchor(oneLine(a.title), anchorsUsed) }));
  for (const { a, anchor: anc } of assignments) if (a.url && !local.has(linkKey(a.url))) local.set(linkKey(a.url), `assignments.md#${anc}`);
  const targets: Targets = { local, readings: new Map() };

  // ---- Course files, with the session. ----
  const total = content.files.length;
  const filesState: Record<string, FileRec> = {};
  let present = 0;
  let downloaded = 0;
  let unchanged = 0;
  for (let i = 0; i < content.files.length; i++) {
    if (signal.aborted) break;
    const f = content.files[i];
    const rel = planned[i];
    progress("files", i, total);
    const key = fileKey(f.url);
    if (f.size !== null && f.size > opts.maxDownload) {
      skipped.push(`${f.name}: too big to download (${mb(f.size)}; the limit is ${mb(opts.maxDownload)})`);
      continue;
    }
    const got = await fetchFile(session, root, f, rel, prevFiles[key], opts);
    if (got.kind === "cancelled") break;
    if (got.kind === "skipped") {
      skipped.push(got.why);
      continue;
    }
    present++;
    if (got.kind === "written") downloaded++;
    else unchanged++;
    filesState[key] = got.rec;
    if (got.kind === "written" || copyIsStale(path.join(root, `${rel}.md`))) {
      try {
        await textCopy(root, rel, signal);
      } catch (e) {
        if ((e as Error).message !== CANCELLED) skipped.push((e as Error).message);
      }
    }
  }
  progress("files", total, total);

  // ---- Links out of the course, without the session. ----
  const texts: string[] = [];
  const seen: LinkSeen[] = [];
  const index = new Map<string, number>();
  const collect = (html: string, base: URL | null, from: string) => {
    const s = scan(html, base ?? session.site.base);
    texts.push(s.text);
    for (const l of s.links) {
      if (l.url.protocol === "mailto:" || session.site.owns(l.url)) continue;
      const key = fileKey(l.url);
      const textbook = isTextbook(l);
      const at = index.get(key);
      if (at !== undefined) seen[at].textbook ||= textbook;
      else {
        index.set(key, seen.length);
        seen.push({ found: l, textbook, from });
      }
    }
  };
  if (content.syllabus !== null) collect(content.syllabus, null, "the syllabus");
  for (const p of content.pages) collect(p.html, p.url, p.title);
  for (const a of content.assignments) collect(a.html, a.url, a.title);
  for (const a of content.announcements) collect(a.html, null, a.title);
  for (const l of content.links) collect(`<a href="${l.url.href.replace(/"/g, "%22")}">${l.title.replace(/</g, "&lt;")}</a>`, null, "the modules");
  const order = seen.map((_, i) => i).sort((x, y) => Number(!seen[x].textbook) - Number(!seen[y].textbook) || x - y);
  const prevLinks = prev?.links ?? {};
  const linksState: Record<string, LinkRec> = {};
  let readingsDir: string;
  try {
    readingsDir = dirIn(root, "readings");
  } catch (e) {
    throw new Error(`The readings folder couldn’t be made: ${(e as Error).message}`);
  }
  const toFetch: number[] = [];
  const staleReadings: string[] = [];
  order.forEach((i, n) => {
    const key = fileKey(seen[i].found.url);
    const r = prevLinks[key];
    const reuse =
      r &&
      (r.path !== undefined ? isPlain(r.path) && r.path.startsWith("readings/") && isFile(path.join(root, r.path)) : r.note === undefined || r.webPage);
    if (reuse) {
      if (r.path !== undefined) {
        taken.reserve(r.path);
        if (copyIsStale(path.join(root, `${r.path}.md`))) staleReadings.push(r.path);
      }
      linksState[key] = { ...r };
    } else if (n < opts.maxLinks) toFetch.push(i);
    else linksState[key] = { note: "not checked (the course links to too many places)", webPage: false };
  });
  const fetchTotal = toFetch.length;
  progress("readings", 0, fetchTotal);
  const temps = new Set<string>();
  const newReadings: string[] = [];
  let done = 0;
  const tasks = toFetch.map((i) => async (): Promise<[number, Fetched | null]> => {
    if (signal.aborted) return [i, null];
    try {
      return [i, await fetchLink(session, readingsDir, seen[i].found.url, seen[i].textbook, opts.maxDownload, temps)];
    } catch (e) {
      if (isCancelled(e) || signal.aborted) return [i, null];
      return [i, { kind: "failed", note: `couldn’t be downloaded: ${(e as Error).message}` }];
    }
  });
  for await (const [i, fetched] of unordered(tasks, 4)) {
    if (signal.aborted || fetched === null) continue;
    done++;
    progress("readings", done, fetchTotal);
    const key = fileKey(seen[i].found.url);
    let rec: LinkRec;
    if (fetched.kind === "saved") {
      const rel = taken.claim(`readings/${segment(fetched.name)}`);
      taken.reserve(`${rel}.md`);
      try {
        finish(fetched.tmp, path.join(root, rel));
        temps.delete(fetched.tmp);
        newReadings.push(rel);
        rec = { path: rel, webPage: false };
        if (fetched.title !== null) rec.title = fetched.title;
        if (fetched.via) rec.via = fetched.via.href;
      } catch (e) {
        temps.delete(fetched.tmp);
        rec = { note: `couldn’t be saved: ${(e as Error).message}`, webPage: false };
      }
    } else if (fetched.kind === "page") {
      rec = { webPage: true };
      if (fetched.title !== null) rec.title = fetched.title;
    } else rec = { note: fetched.note, webPage: false };
    linksState[key] = rec;
  }
  for (const t of temps) fs.rmSync(t, { force: true });
  for (const l of seen) {
    const p = linksState[fileKey(l.found.url)]?.path;
    if (p !== undefined) targets.readings.set(linkKey(l.found.url), p);
  }
  for (const rel of [...newReadings, ...staleReadings]) {
    try {
      await textCopy(root, rel, signal);
    } catch (e) {
      if ((e as Error).message !== CANCELLED) skipped.push((e as Error).message);
    }
  }

  // Stopped before the Markdown: record what's finished on top of the last record.
  if (signal.aborted) {
    const files = { ...(prev?.files ?? {}), ...filesState };
    const links = { ...(prev?.links ?? {}), ...linksState };
    const state: CourseState = {
      name: course.name,
      code: course.code ?? undefined,
      term: course.term ?? undefined,
      folder,
      files,
      links,
      due: prev ? [...prev.due] : [],
      lastSync: prev?.lastSync,
      material: prev?.material,
    };
    if (!prev || prev.partial) state.partial = true;
    return { state, files: present, downloaded, unchanged, readings: Object.values(links).filter((r) => r.path !== undefined).length, links: 0, skipped, cancelled: true, written: false };
  }

  // ---- The Markdown. ----
  progress("writing", 0, 1);
  const put = (rel: string, body: string) => void writeUnlessSame(root, rel, body, null);
  const md = (src: string, base: URL | null, depth: number) => toMarkdown(src, base ?? session.site.base, (u) => rewrite(targets, session, u, depth));
  if (content.syllabus !== null) put("syllabus.md", `# Syllabus: ${course.name}\n\n${md(content.syllabus, null, 0)}\n`);
  const due: Due[] = [];
  if (assignments.length) {
    let s = `# Assignments: ${course.name}\n\nBy due date; undated ones last.\n\n`;
    for (const { a, anchor: anc, t } of assignments) {
      s += `## ${oneLine(a.title)}\n\n`;
      const facts = [t !== null ? `Due ${displayTime(t)}` : "No due date"];
      if (a.points !== null) facts.push(`${a.points} points`);
      s += facts.join(" · ") + "\n\n";
      const body = md(a.html, a.url, 0);
      if (body) s += body + "\n\n";
      if (a.due !== null && t !== null) due.push({ title: oneLine(a.title), due: a.due, anchor: anc });
    }
    put("assignments.md", s);
  }
  if (content.announcements.length) {
    const list = content.announcements
      .map((a, i) => ({ a, i, t: a.posted !== null ? parseTime(a.posted) : null }))
      .sort((x, y) => (x.t === null ? 1 : 0) - (y.t === null ? 1 : 0) || (y.t ?? 0) - (x.t ?? 0) || x.i - y.i);
    let s = `# Announcements: ${course.name}\n\nNewest first.\n\n`;
    for (const { a, t } of list) {
      s += `## ${oneLine(a.title)}\n\n`;
      if (t !== null) s += `Posted ${displayTime(t)}\n\n`;
      s += md(a.html, null, 0) + "\n\n";
    }
    put("announcements.md", s);
  }
  content.pages.forEach((p, i) => put(pagePaths[i], `# ${oneLine(p.title)}\n\n${md(p.html, p.url, 1)}\n`));
  if (content.modules.length) {
    const byTitle = new Map<string, string>();
    const add = (k: string, v: string) => {
      if (!byTitle.has(k)) byTitle.set(k, v);
    };
    content.pages.forEach((p, i) => add(p.title, linkTarget(pagePaths[i])));
    for (const { a, anchor: anc } of assignments) add(a.title, `assignments.md#${anc}`);
    content.files.forEach((f, i) => {
      if (filesState[fileKey(f.url)]) add(f.name, linkTarget(planned[i]));
    });
    for (const l of content.links) add(l.title, l.url.href);
    let s = `# Modules: ${course.name}\n\nIn the course’s order.\n\n`;
    for (const m of content.modules) {
      s += `## ${oneLine(m.name)}\n\n`;
      for (const item of m.items) {
        const t = byTitle.get(item);
        s += t !== undefined ? `- [${noBrackets(oneLine(item))}](${t})\n` : `- ${oneLine(item)}\n`;
      }
      s += "\n";
    }
    put("modules.md", s);
  }
  const webPages = seen.filter((l) => {
    const r = linksState[fileKey(l.found.url)];
    return r && r.webPage && r.path === undefined;
  });
  if (webPages.length) {
    let s = `# Links: ${course.name}\n\nWeb pages the course links to. They aren’t saved here; open them in a browser.\n\n`;
    for (const l of webPages) {
      const rec = linksState[fileKey(l.found.url)];
      let label = noBrackets(rec.title ? rec.title : oneLine(l.found.text));
      if (!label) label = l.found.url.href;
      s += `- [${label}](${l.found.url.href}) (from ${l.from})\n`;
    }
    put("links.md", s);
  }
  if (opts.grades) writeUnlessSame(root, GRADES_MD, gradesMarkdown(course.name, opts.grades), GRADES_STAMP);

  // ---- README. ----
  const said = new Set<string>();
  const uniqueSkipped = skipped.filter((k) => (said.has(k) ? false : (said.add(k), true)));
  const isbns: Isbn[] = [];
  for (const t of texts) for (const i of findIsbns(t)) if (!isbns.some((a) => a.isbn === i.isbn)) isbns.push(i);
  const text = readme(course, session, content, assignments, seen, linksState, isbns, filesState, pagePaths, uniqueSkipped, root, opts.grades);
  writeUnlessSame(root, README, text, README_STAMP);
  progress("writing", 1, 1);

  // ---- What each document is made of. ----
  const docs = [...Object.values(filesState).map((r) => r.path), ...Object.values(linksState).flatMap((r) => (r.path !== undefined ? [r.path] : []))].filter((p) => kindOf(p) !== "other");
  let material: Report | undefined;
  try {
    material = await assessCourse(root, docs, prev?.material, (p) => pdfLayers(p, signal), signal);
  } catch {
    material = undefined;
  }
  if (signal.aborted) material = prev?.material;

  const state: CourseState = {
    name: course.name,
    code: course.code ?? undefined,
    term: course.term ?? undefined,
    folder,
    files: filesState,
    links: linksState,
    due,
    lastSync: nowMs(),
    material,
  };
  return {
    state,
    files: present,
    downloaded,
    unchanged,
    readings: Object.values(linksState).filter((r) => r.path !== undefined).length,
    links: webPages.length,
    skipped: uniqueSkipped,
    cancelled: signal.aborted,
    written: true,
  };
}

function looksLikeDocument(u: URL): boolean {
  return ["pdf", "epub", "docx", "doc", "pptx", "ppt", "xlsx", "odt", "rtf"].includes(extOf(u.pathname));
}

function readme(
  course: Course,
  session: Session,
  content: CourseContent,
  assignments: Planned[],
  seen: LinkSeen[],
  links: Record<string, LinkRec>,
  isbns: Isbn[],
  files: Record<string, FileRec>,
  pages: string[],
  skipped: string[],
  root: string,
  grades: CourseGrades | null,
): string {
  let s = `# ${oneLine(course.name)}\n\n`;
  const facts = [course.code, course.term].filter((x): x is string => typeof x === "string");
  if (facts.length) s += `${facts.join(" · ")}\n\n`;
  s += `Imported from ${session.site.address()} on ${displayTime(nowSecs())}. Importing again updates this folder and downloads only what changed.\n\n`;
  const gl = readmeGradesLine(grades, isFile(path.join(root, GRADES_MD)));
  if (gl !== null) s += gl + "\n\n";

  s += "## Coming up\n\n";
  const now = nowSecs();
  const next = assignments.filter((x) => x.t !== null && x.t >= now).slice(0, 10);
  if (!next.length) s += "Nothing with a due date ahead on the course site.\n\n";
  else {
    for (const { a, anchor: anc, t } of next) s += `- ${displayTime(t ?? 0)}: [${noBrackets(oneLine(a.title))}](assignments.md#${anc})\n`;
    s += "\n";
  }

  s += "## Textbooks and readings\n\n";
  let any = false;
  const label = (l: LinkSeen, r: LinkRec) => {
    let t = r.title ? r.title : oneLine(l.found.text);
    if (!t) t = l.found.url.href;
    return noBrackets(t);
  };
  const placed = isbns.map(() => false);
  const isbnOf = (l: LinkSeen): string => {
    const text = oneLine(l.found.text);
    let out = "";
    isbns.forEach((i, n) => {
      if (!placed[n] && text && (i.line.includes(text) || l.found.context.includes(i.line) || l.found.context.includes(i.isbn))) {
        placed[n] = true;
        out += ` ISBN ${i.isbn}.`;
      }
    });
    return out;
  };
  for (const l of seen.filter((x) => x.textbook)) {
    const r = links[fileKey(l.found.url)];
    if (!r) continue;
    any = true;
    const isbn = isbnOf(l);
    if (r.path !== undefined) {
      const p = r.path;
      const source = r.via !== undefined ? `the PDF linked from its page ${r.via}` : `downloaded from ${l.found.url.href}`;
      const copy = kindOf(p) !== "other" && isFile(path.join(root, `${p}.md`)) ? ` Text copy: [${p}.md](${linkTarget(p)}.md).` : "";
      s += `- **Textbook**: [${label(l, r)}](${linkTarget(p)}), ${source} (linked from ${l.from}).${isbn}${copy}\n`;
    } else if (r.webPage) {
      s += `- **Textbook**: [${label(l, r)}](${l.found.url.href}) (linked from ${l.from}) is a web page, not a file, so there’s no copy here; read it online.\n`;
    } else {
      s += `- **Textbook**: [${label(l, r)}](${l.found.url.href}) (linked from ${l.from}) ${r.note ?? "wasn’t downloaded"}.\n`;
    }
  }
  isbns.forEach((i, n) => {
    if (placed[n]) return;
    any = true;
    s += `- **Textbook**: ISBN ${i.isbn}, from “${noBrackets(i.line.replace(/\.+$/, ""))}”. The course doesn’t link a copy; the library or bookstore can find it by this number.\n`;
  });
  for (const l of seen.filter((x) => !x.textbook)) {
    const r = links[fileKey(l.found.url)];
    if (!r) continue;
    if (r.path !== undefined) {
      any = true;
      s += `- Reading: [${label(l, r)}](${linkTarget(r.path)}), downloaded from ${l.found.url.href} (linked from ${l.from}).\n`;
    } else if (!r.webPage && r.note !== undefined && looksLikeDocument(l.found.url)) {
      any = true;
      s += `- Reading: [${label(l, r)}](${l.found.url.href}) (linked from ${l.from}) ${r.note}.\n`;
    }
  }
  if (!any) s += "The course doesn’t name a textbook or link any readings.\n";
  s += "\n";

  s += "## In this folder\n\n";
  s += content.syllabus !== null ? "- [syllabus.md](syllabus.md): the syllabus\n" : "- The course site has no syllabus for this course.\n";
  if (assignments.length) s += `- [assignments.md](assignments.md): ${count(assignments.length, "assignment", "assignments")} by due date\n`;
  if (grades || isFile(path.join(root, GRADES_MD))) s += "- [grades.md](grades.md): your grades, by group\n";
  if (content.announcements.length) s += `- [announcements.md](announcements.md): ${count(content.announcements.length, "announcement", "announcements")}, newest first\n`;
  if (content.modules.length) s += `- [modules.md](modules.md): ${count(content.modules.length, "module", "modules")} in the course’s order\n`;
  const web = Object.values(links).filter((r) => r.webPage && r.path === undefined).length;
  if (web > 0) s += `- [links.md](links.md): ${count(web, "web page", "web pages")} the course links to\n`;
  const list = (title: string, items: string[]) => {
    if (!items.length) return;
    s += `\n### ${title}\n\n`;
    for (const it of items.slice(0, INDEX_LIST_MAX)) s += `- [${noBrackets(it)}](${linkTarget(it)})\n`;
    if (items.length > INDEX_LIST_MAX) s += `- …and ${items.length - INDEX_LIST_MAX} more\n`;
  };
  const byteSort = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  list("Pages", pages);
  list(
    "Files",
    Object.values(files)
      .map((r) => r.path)
      .sort(byteSort),
  );
  list(
    "Readings",
    Object.values(links)
      .flatMap((r) => (r.path !== undefined ? [r.path] : []))
      .sort(byteSort),
  );
  if (skipped.length) {
    s += "\n## Not imported\n\n";
    for (const k of skipped) s += `- ${k}\n`;
  }
  return s;
}

// ---- Grades ------------------------------------------------------------------

/** README's line about grades. */
export function readmeGradesLine(grades: CourseGrades | null, fileThere: boolean): string | null {
  if (grades) {
    const w = gradeWords(grades.current);
    if (w !== null) return `**Grades**: ${w} so far. Every grade, by group: [grades.md](grades.md).`;
    if (grades.note !== undefined) return `**Grades**: ${grades.note} See [grades.md](grades.md).`;
    return "**Grades**: no course grade yet. What’s been graded: [grades.md](grades.md).";
  }
  return fileThere ? "**Grades**: [grades.md](grades.md) (from the last time they could be read)." : null;
}

/** grades.md: the course grade, then each group (with its weight) and its items. */
export function gradesMarkdown(course: string, g: CourseGrades): string {
  let s = `# Grades: ${oneLine(course)}\n\n`;
  s += `Read from the course site on ${displayTime(nowSecs())}. Only grades the course has released to you are here; the rest show as not graded yet.\n\n`;
  if (g.note !== undefined) s += `${g.note}\n\n`;
  const w = gradeWords(g.current);
  if (w !== null) {
    const c = g.current;
    const pts = c.points !== undefined && c.possible !== undefined && (c.percent !== undefined || c.letter !== undefined) ? `, ${num(c.points)} of ${num(c.possible)} points` : "";
    s += `**Current grade: ${w}**${pts} (counting only what’s been graded).\n\n`;
  }
  const fw = g.final ? gradeWords(g.final) : null;
  if (fw !== null) s += `Final grade if nothing more is graded (work not graded counts as zero): ${fw}.\n\n`;
  const sections: { name: string; weight?: number; items: GradeItem[] }[] = g.groups.map((gr) => ({ name: gr.name, weight: gr.weight, items: [] }));
  const other: GradeItem[] = [];
  for (const it of g.items) {
    const sec = it.group !== undefined ? sections.find((x) => x.name === it.group) : undefined;
    if (sec) sec.items.push(it);
    else other.push(it);
  }
  if (other.length) sections.push({ name: sections.length ? "Other" : "Graded work", items: other });
  for (const { name, weight, items } of sections) {
    s += weight !== undefined ? `## ${oneLine(name)} (${num(weight)}% of the grade)\n\n` : `## ${oneLine(name)}\n\n`;
    if (!items.length) {
      s += "Nothing here yet.\n\n";
      continue;
    }
    for (const it of items) {
      s += `- **${oneLine(it.title).replace(/\*/g, "\\*")}**: ${itemWords(it)}\n`;
      for (const c of it.comments) s += `  - Teacher’s comment: ${oneLine(c)}\n`;
    }
    s += "\n";
  }
  return s.trimEnd() + "\n";
}

function itemWords(it: GradeItem): string {
  const parts: string[] = [];
  if (it.excused) parts.push("excused (doesn’t count)");
  else if (it.score !== undefined) {
    let w = it.possible !== undefined ? `${num(it.score)} / ${num(it.possible)}` : `${num(it.score)} points`;
    if (it.percent !== undefined) w += ` (${num(it.percent)}%)`;
    if (it.grade !== undefined) w += `, ${it.grade}`;
    parts.push(w);
  } else if (it.grade !== undefined) parts.push(it.grade);
  else parts.push(it.possible !== undefined ? `not graded yet (out of ${num(it.possible)})` : "not graded yet");
  const t = it.due !== undefined ? parseTime(it.due) : null;
  if (t !== null) parts.push(`due ${displayTime(t)}`);
  if (it.missing) parts.push("missing");
  if (it.late) parts.push("late");
  if (it.submitted && !it.graded) parts.push("handed in, not graded yet");
  return parts.join(" · ");
}

/** Write grades.md into an existing course folder (a grades refresh) and update README's grades line. */
export function writeGrades(courseDir: string, course: string, g: CourseGrades): void {
  const body = gradesMarkdown(course, g);
  try {
    // Unchanged apart from the date: leave it (and its sync) alone.
    writeUnlessSame(courseDir, GRADES_MD, body, GRADES_STAMP);
  } catch (e) {
    throw new Error(`grades.md couldn’t be written: ${(e as Error).message.replace(/^grades\.md couldn’t be written: /, "")}`);
  }
  const readmePath = path.join(courseDir, README);
  let text: string;
  try {
    if (!fs.lstatSync(readmePath).isFile()) return;
    text = fs.readFileSync(readmePath, "utf8");
  } catch {
    return;
  }
  const line = readmeGradesLine(g, true) ?? "";
  const ls = lines(text);
  const n = ls.findIndex((l) => l.startsWith("**Grades**:"));
  let updated: string;
  if (n >= 0) updated = ls.map((l, i) => (i === n ? line : l)).join("\n") + "\n";
  else {
    const at = text.indexOf("\n\n## ");
    updated = at >= 0 ? `${text.slice(0, at)}\n\n${line}${text.slice(at)}` : `${text}\n${line}\n`;
  }
  if (updated !== text) {
    try {
      write(courseDir, README, updated);
    } catch (e) {
      throw new Error(`README.md couldn’t be updated: ${(e as Error).message}`);
    }
  }
}
