import fs from "node:fs";
import path from "node:path";
import { CANT_RECOGNISE, kindOf, letters, NO_TEXT_IN_PICTURE, ocrAvailability, pngSizeOf, RECOGNISED, SPARSE, withPictureNotes, type Layer } from "./text/index.ts";

/**
 * What each imported course document is made of, so nobody works from bad
 * text without knowing it: typed pages, pages that are handwriting or scans
 * (with how many of their words the course's typed material also uses),
 * typed pages that also show pictures, and pages nothing could be read from.
 * Worked out at every import from each document's text copy and its pages'
 * text layers, and kept with the course in lms.json.
 */

/** 2: a template's pictures and icon-sized picture files are no longer counted as pictures. */
export const MATERIAL_VERSION = 2;
const ICON_SIDE = 400;
export const GOOD = 0.85;
export const FAIR = 0.65;
const COPY_MAX = 16 * 1024 * 1024;

export type FileQuality = {
  /** Relative to the course folder ("files/Notes/week 3.pdf"). */
  path: string;
  pages: number;
  typed: number;
  handwriting?: number[];
  unreadable?: number[];
  /** Typed pages that also show pictures: [page, how many]. */
  pictures?: [number, number][];
  knownWords?: number;
  size: number;
  copyModified: number;
};

export type Report = { version: number; files: FileQuality[]; cantRecognise?: string };

export type Flagged = { path: string; handwriting: number; unreadable: number; pictures: number; knownWords?: number };

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
  flagged: Flagged[];
};

/** A FileQuality as lms.json holds it, with every field filled (`typed` included: a hand-edited block mustn't break the file). */
export function normalizeQuality(raw: unknown): FileQuality | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const pages = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
  const q: FileQuality = { path: r.path, pages: num(r.pages), typed: num(r.typed), size: num(r.size), copyModified: num(r.copyModified) };
  const hw = pages(r.handwriting);
  const un = pages(r.unreadable);
  const pics = Array.isArray(r.pictures)
    ? r.pictures.filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && typeof p[0] === "number" && typeof p[1] === "number")
    : [];
  return withLists(q, hw, un, pics, typeof r.knownWords === "number" ? r.knownWords : undefined);
}

/** A Report as lms.json holds it, or undefined when it isn't one. */
export function normalizeReport(raw: unknown): Report | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== "number" || !Array.isArray(r.files)) return undefined;
  const out: Report = { version: r.version, files: r.files.map(normalizeQuality).filter((f): f is FileQuality => f !== null) };
  if (typeof r.cantRecognise === "string") out.cantRecognise = r.cantRecognise;
  return out;
}

/** Field order as serde wrote it; empty lists and a missing share left out. */
function withLists(q: FileQuality, hw: number[], un: number[], pics: [number, number][], known: number | undefined): FileQuality {
  const out: FileQuality = { path: q.path, pages: q.pages, typed: q.typed } as FileQuality;
  if (hw.length) out.handwriting = hw;
  if (un.length) out.unreadable = un;
  if (pics.length) out.pictures = pics;
  if (known !== undefined) out.knownWords = known;
  out.size = q.size;
  out.copyModified = q.copyModified;
  return out;
}

const hwOf = (f: FileQuality) => f.handwriting ?? [];
const unOf = (f: FileQuality) => f.unreadable ?? [];
const picsOf = (f: FileQuality) => f.pictures ?? [];

export function flaggedPages(f: FileQuality): number {
  return hwOf(f).length + unOf(f).length;
}
export function pictureCount(f: FileQuality): number {
  return picsOf(f).reduce((a, [, n]) => a + n, 0);
}
export function isFlagged(f: FileQuality): boolean {
  return flaggedPages(f) > 0 || picsOf(f).length > 0;
}
/** Pages worth showing a model that can look at pictures: handwriting and unreadable first, then typed pages with pictures. */
export function picturePages(f: FileQuality): number[] {
  const out = [...hwOf(f), ...unOf(f)].sort((a, b) => a - b);
  out.push(...picsOf(f).map(([p]) => p));
  return out;
}

export function readability(share: number): "good" | "fair" | "poor" {
  return share >= GOOD ? "good" : share >= FAIR ? "fair" : "poor";
}

/** An f32 written the way serde_json writes one (shortest digits that read back as the same f32). */
function f32(x: number): number {
  const f = Math.fround(x);
  for (let p = 1; p <= 9; p++) {
    const v = Number(f.toPrecision(p));
    if (Math.fround(v) === f) return v;
  }
  return f;
}

/** A Summary of the documents of `report` for which `keep` holds. */
export function summarise(report: Report, keep: (f: FileQuality) => boolean): Summary {
  const files = report.files.filter(keep);
  const s: Summary = { documents: files.length, typedDocuments: 0, handwritingPages: 0, unreadablePages: 0, pictures: 0, lines: [], flagged: [] };
  if (report.cantRecognise !== undefined) s.cantRecognise = report.cantRecognise;
  let known = 0;
  let weight = 0;
  for (const f of files) {
    s.handwritingPages += hwOf(f).length;
    s.unreadablePages += unOf(f).length;
    s.pictures += pictureCount(f);
    if (isFlagged(f)) {
      const fl: Flagged = { path: f.path, handwriting: hwOf(f).length, unreadable: unOf(f).length, pictures: pictureCount(f) };
      if (f.knownWords !== undefined) fl.knownWords = f.knownWords;
      s.flagged.push(fl);
    } else s.typedDocuments++;
    if (f.knownWords !== undefined) {
      known = Math.fround(known + Math.fround(f.knownWords * hwOf(f).length));
      weight += hwOf(f).length;
    }
  }
  if (weight > 0) {
    const share = Math.fround(known / weight);
    s.readability = readability(share);
    s.knownWords = f32(share);
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
  if (!s.lines.length && s.documents > 0) s.lines.push(`${s.documents === 1 ? "The document is" : `All ${s.documents} documents are`} typed text, read as it is.`);
  // Field order as serde wrote it.
  const out: Summary = { documents: s.documents, typedDocuments: s.typedDocuments, handwritingPages: s.handwritingPages, unreadablePages: s.unreadablePages, pictures: s.pictures } as Summary;
  if (s.readability !== undefined) out.readability = s.readability;
  if (s.knownWords !== undefined) out.knownWords = s.knownWords;
  if (s.cantRecognise !== undefined) out.cantRecognise = s.cantRecognise;
  out.lines = s.lines;
  out.flagged = s.flagged;
  return out;
}

// ---- Working it out ---------------------------------------------------------------

function rustLines(s: string): string[] {
  const lines = s.split("\n");
  if (s.endsWith("\n")) lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** A text copy's pages: number → [recognised from a picture?, its text]. */
function copyPages(copy: string): Map<number, [boolean, string]> {
  const out = new Map<number, [boolean, string]>();
  let cur: [number, boolean, string] | null = null;
  for (const line of rustLines(copy)) {
    if (line.startsWith("## Page ")) {
      if (cur) out.set(cur[0], [cur[1], cur[2]]);
      cur = null;
      const rest = line.slice(8);
      const num = /^\d+/.exec(rest)?.[0];
      if (num !== undefined && Number(num) <= 0xffffffff) cur = [Number(num), rest.includes(RECOGNISED), ""];
      continue;
    }
    if (cur) cur[2] += line + "\n";
  }
  if (cur) out.set(cur[0], [cur[1], cur[2]]);
  return out;
}

function saysUnreadable(body: string): boolean {
  const b = body.trim();
  return b.startsWith("(") && (b.includes(CANT_RECOGNISE) || b.includes("couldn’t be recognised") || b.includes("needs macOS for now") || b.includes("such pages are recognised"));
}

/** One PDF, from its pages' text layers and its text copy. */
export function assessPdf(rel: string, layers: Layer[], copy: string): FileQuality {
  const pages = copyPages(copy);
  let typed = 0;
  const hw: number[] = [];
  const un: number[] = [];
  const pics: [number, number][] = [];
  for (const l of layers) {
    const typedLayer = letters(l.text) >= SPARSE;
    const p = pages.get(l.page);
    if (p && p[0]) hw.push(l.page);
    else if (p && saysUnreadable(p[1])) un.push(l.page);
    else if (p && p[1].trim() === "(No text was found on this page.)") {
      if (l.pictures > 0) un.push(l.page);
    } else if (typedLayer) {
      typed++;
      if (l.pictures > 0) pics.push([l.page, l.pictures]);
    } else if (p) typed++;
    else un.push(l.page);
  }
  return withLists({ path: rel, pages: layers.length, typed, size: 0, copyModified: 0 }, hw, un, pics, undefined);
}

/** A picture file, from its text copy. */
export function assessPicture(rel: string, copy: string): FileQuality {
  const q = { path: rel, pages: 1, typed: 0, size: 0, copyModified: 0 };
  if (copy.includes("## Picture") && copy.includes(RECOGNISED)) return withLists(q, [1], [], [], undefined);
  if (copy.includes(NO_TEXT_IN_PICTURE)) return withLists(q, [], [], [[1, 1]], undefined);
  return withLists(q, [], [1], [], undefined);
}

function pictureSize(file: string): [number, number] | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const head = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, head, 0, head.length, 0);
      return pngSizeOf(head.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function modifiedMs(file: string): number {
  try {
    return Math.floor(fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

function readCopy(file: string): string | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > COPY_MAX) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Words worth checking: letters only, three or more, lower case. */
function words(text: string): string[] {
  return text
    .split(/[^\p{Alphabetic}]+/u)
    .filter((w) => [...w].length >= 3)
    .map((w) => w.toLowerCase());
}

const COMMON =
  "the and for are but not you all any can had her was one our out day get has him his how man new now old see two way who boy did its let put say she too use that with have this will your from they know want been good much some time very when come here just like long make many more only over such take than them well were what where which while would there their about after again also back because before being between both could each even every first give great into last little look most must never next other right same should since small still these thing think those three through under until upon used using want went work world year then then example examples note notes section chapter page lecture class problem problems answer question questions show prove proof true false given find value values number numbers case cases set sets list called means mean define defined definition rule rules form forms part parts order step steps method follows following therefore thus hence let suppose assume consider write written read";

const DOC_EXTS = new Set(["pdf", "docx", "pptx", "png", "jpg", "jpeg", "heic", "heif", "tif", "tiff", "gif", "webp", "bmp"]);

/** Markdown the import wrote itself (not a document's text copy). */
function isPlainMarkdown(name: string): boolean {
  const stem = name.replace(/(\.md)+$/, "");
  const ext = path.extname(stem).slice(1).toLowerCase();
  return !(path.extname(stem) && DOC_EXTS.has(ext));
}

/** The course's typed words: its typed pages and Markdown (syllabus, pages, assignments…). */
function vocabulary(root: string, report: Report): Set<string> {
  const v = new Set(COMMON.split(/\s+/).filter(Boolean));
  const add = (t: string) => {
    for (const w of words(t)) v.add(w);
  };
  for (const f of report.files) {
    const copy = readCopy(path.join(root, `${f.path}.md`));
    if (copy === null) continue;
    if (f.pages === 0) {
      add(copy);
      continue;
    }
    for (const [n, [recognised, body]] of copyPages(copy)) if (!recognised && !unOf(f).includes(n)) add(body);
  }
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory() && seen < 2000) {
        seen++;
        stack.push(p);
      } else if (e.isFile() && e.name.endsWith(".md") && isPlainMarkdown(e.name)) {
        const t = readCopy(p);
        if (t !== null) add(t);
      }
    }
  }
  return v;
}

/** Of the words read from `f`'s handwriting pages, the share in `vocab`. */
function knownShare(root: string, f: FileQuality, vocab: Set<string>): number | undefined {
  if (!hwOf(f).length) return undefined;
  const copy = readCopy(path.join(root, `${f.path}.md`));
  if (copy === null) return undefined;
  const pages = copyPages(copy);
  const bodies = f.pages === 1 && pages.size === 0 ? [copy] : hwOf(f).flatMap((n) => (pages.has(n) ? [pages.get(n)![1]] : []));
  let known = 0;
  let all = 0;
  for (const body of bodies) {
    for (const w of words(body)) {
      all++;
      if (vocab.has(w) || vocab.has(w.replace(/s+$/, ""))) known++;
    }
  }
  return all > 0 ? Math.fround(known / all) : undefined;
}

function sameQuality(a: FileQuality, b: FileQuality): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Every document in `docs` (paths relative to the course folder `root`),
 * reusing what `prev` found for one unchanged since. `layers` reads a PDF's
 * pages (the text child). A document with no text copy is left out.
 * Rejects with "cancelled" once `signal` aborts.
 */
export async function assessCourse(root: string, docs: string[], prev: Report | undefined, layers: (absPath: string) => Promise<Layer[]>, signal?: AbortSignal): Promise<Report> {
  const report: Report = { version: MATERIAL_VERSION, files: [] };
  const cant = ocrAvailability();
  if (cant !== null) report.cantRecognise = cant;
  const seen = new Set<string>();
  for (const rel of docs) {
    if (signal?.aborted) throw new Error("cancelled");
    if (seen.has(rel)) continue;
    seen.add(rel);
    const full = path.join(root, rel);
    const copyPath = path.join(root, `${rel}.md`);
    let copy = readCopy(copyPath);
    if (copy === null) continue;
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      size = 0;
    }
    let copyModified = modifiedMs(copyPath);
    const old = prev && prev.version === MATERIAL_VERSION ? prev.files.find((f) => f.path === rel) : undefined;
    if (old && old.size === size && old.copyModified === copyModified) {
      report.files.push(old);
      continue;
    }
    let q: FileQuality;
    const kind = kindOf(full);
    if (kind === "pdf") {
      let l: Layer[] | null = null;
      try {
        l = await layers(full);
      } catch (e) {
        if (signal?.aborted) throw new Error("cancelled");
        void e;
        l = null;
      }
      if (l) {
        // A copy made before decoration was told apart notes pictures that aren't.
        const fixed = withPictureNotes(copy, l);
        if (fixed !== null) {
          try {
            fs.writeFileSync(copyPath, fixed);
            copyModified = modifiedMs(copyPath);
            copy = fixed;
          } catch {
            // keep the copy as it was
          }
        }
        q = assessPdf(rel, l, copy);
      } else q = { path: rel, pages: 0, typed: 0, size: 0, copyModified: 0 };
    } else if (kind === "picture") {
      const sz = copy.includes(NO_TEXT_IN_PICTURE) ? pictureSize(full) : null;
      if (sz && Math.max(sz[0], sz[1]) < ICON_SIDE) continue;
      q = assessPicture(rel, copy);
    } else if (kind === "docx" || kind === "pptx") q = { path: rel, pages: 0, typed: 0, size: 0, copyModified: 0 };
    else continue;
    q.size = size;
    q.copyModified = copyModified;
    report.files.push(q);
  }
  const vocab = vocabulary(root, report);
  report.files = report.files.map((f) => {
    const s = knownShare(root, f, vocab);
    const next = withLists(f, hwOf(f), unOf(f), picsOf(f), s === undefined ? undefined : Math.round(s * 1000) / 1000);
    return sameQuality(next, f) ? f : next;
  });
  report.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return report;
}

/** The documents of a course folder worth assessing: those under files/ and readings/ a text copy is made for. */
export function documents(root: string): string[] {
  const out: string[] = [];
  for (const top of ["files", "readings"]) {
    const stack = [path.join(root, top)];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && out.length < 5000) stack.push(p);
        else if (e.isFile() && kindOf(p) !== "other") out.push(path.relative(root, p).split(path.sep).join("/"));
      }
    }
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
