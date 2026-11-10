import fs from "node:fs";
import path from "node:path";
import { cleanRel } from "../core/resolve.ts";
import { extensionOf, lstat } from "./files.ts";
import { flaggedPages, picturePages, RECOGNISED, summarise, type FileQuality, type Report } from "./lms.ts";
import { pageAt, pageText, roughly } from "./quote.ts";
import { alert } from "./sight.ts";
import { clean, type CourseFile } from "./sources.ts";
import { cutBytes, rustLines } from "./text.ts";
import type { Alert, ExamScope, Picture, ScopeMap, Sight, Topic } from "./types.ts";
import { folderOf, type Seen, type Visible } from "./visible.ts";

/**
 * Study and what a course's documents are made of (Rust `study::material`):
 * which pages a model reads badly from their text, their pictures for a model
 * that can look, a quote read from such a picture checked against the page's
 * recognised text, and what to tell the person when their model can't look.
 */

/** Pictures shown in one call: mapping, writing, checking. */
export const MAP_PICTURES = 6;
export const WRITE_PICTURES = 6;
export const CHECK_PICTURES = 4;
/** Most bytes of pictures (as base64) in one call. */
export const CALL_BYTES = 16 * 1024 * 1024;
/** Largest picture file sent as it is. */
export const FILE_BYTES = 3_500_000;

/** A page of a course file: its label (`courses/<folder>/files/x.pdf`) and page number. */
export type PageRef = [label: string, page: number];

export type RenderedPage = { page: number; mime: string; data: string };
export type PagePictureRenderer = (pdfPath: string, pages: number[]) => RenderedPage[];

let renderer: PagePictureRenderer | null = null;

/**
 * Sets how PDF pages become pictures. Owned by the LMS text module (PDF page
 * rendering); until one is registered, PDFs give no pictures.
 */
export function setPagePictureRenderer(fn: PagePictureRenderer | null): void {
  renderer = fn;
}

export function reportOf(seen: Seen): Report | null {
  return seen.state.material ?? null;
}

/** The file a label names inside the course folder ("files/x.pdf"). */
export function relOf(seen: Seen, label: string): string | null {
  const prefix = `courses/${folderOf(seen)}/`;
  return label.startsWith(prefix) ? label.slice(prefix.length) : null;
}

/** What the report says about the file `label` names. */
export function quality(seen: Seen, label: string): FileQuality | null {
  const rel = relOf(seen, label);
  if (rel === null) return null;
  return reportOf(seen)?.files.find((f) => f.path === rel) ?? null;
}

/** Pages that count against a model that can't see. */
function weight(f: FileQuality): number {
  return flaggedPages(f) + (f.pictures?.length ?? 0);
}

const PICTURE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

function pictureFile(p: string, label: string): Picture | null {
  const ext = extensionOf(path.basename(p));
  const mime = ext === null ? undefined : PICTURE_MIME[ext.replace(/[A-Z]/g, (c) => c.toLowerCase())];
  if (!mime) return null;
  try {
    if (fs.statSync(p).size > FILE_BYTES) return null;
    return { label, mime, data: fs.readFileSync(p).toString("base64") };
  } catch {
    return null;
  }
}

/** The pictures of `pages`, at most `max` (and CALL_BYTES in all), in the order given. A page that can't be had is left out. */
export function pictures(visible: Visible, seen: Seen, pages: PageRef[], max: number): Picture[] {
  const asked = pages.slice(0, max);
  const byFile = new Map<string, number[]>();
  for (const [label, page] of asked) {
    const list = byFile.get(label) ?? [];
    list.push(page);
    byFile.set(label, list);
  }
  const got: { label: string; page: number; pic: Picture }[] = [];
  for (const [label, wanted] of byFile) {
    let clean: string[];
    try {
      clean = cleanRel(label);
    } catch {
      continue;
    }
    let place;
    try {
      place = visible.place(clean, true);
    } catch {
      continue;
    }
    if (place.kind !== "course" || place.seen.key !== seen.key) continue;
    const file = place.real;
    if (!lstat(file)?.isFile()) continue;
    const ext = (extensionOf(path.basename(file)) ?? "").toLowerCase();
    if (ext === "pdf") {
      if (!renderer) continue;
      let rendered: RenderedPage[] = [];
      try {
        rendered = renderer(file, wanted);
      } catch {
        rendered = [];
      }
      for (const p of rendered) got.push({ label, page: p.page, pic: { label: `${label}, page ${p.page}`, mime: p.mime, data: p.data } });
    } else {
      const pic = pictureFile(file, label);
      if (pic) got.push({ label, page: 1, pic });
    }
  }
  const out: Picture[] = [];
  let bytes = 0;
  for (const [label, page] of asked) {
    const i = got.findIndex((g) => g.label === label && g.page === page);
    if (i < 0) continue;
    const { pic } = got.splice(i, 1)[0]!;
    if (bytes + pic.data.length > CALL_BYTES) break;
    bytes += pic.data.length;
    out.push(pic);
  }
  return out;
}

/** What the model is told about the pictures it is shown. */
export function picturesNote(shown: Picture[]): string {
  if (!shown.length) return "";
  return `\n\n<pictures>\nThe pictures attached are these pages, in order: ${shown.map((p) => p.label).join("; ")}. Each is handwriting, a scan, or a page with a figure; its text above was read by text recognition and may be wrong, or is missing. Read them from the pictures. A quote from one of these pages may be in the words you see on it, cited by the file's path as usual: it is checked against the recognised text loosely, and shown as read from a picture.\n</pictures>`;
}

/** A quote not word for word in a file's text, checked against the recognised pages shown as pictures: the page it roughly matches. */
export function pictureQuote(copy: string, shown: number[], q: string): number | null {
  const lines = rustLines(copy);
  const recognised = (p: number) => lines.some((l) => l.startsWith("## Page ") && l.slice(8).startsWith(`${p} `) && l.includes(RECOGNISED));
  for (const p of shown) {
    if (!recognised(p)) continue;
    const t = pageText(copy, p);
    if (t !== null && roughly(t, q)) return p;
  }
  return null;
}

function pageNumbersIn(body: string): number[] {
  const out: number[] = [];
  for (const l of rustLines(body)) {
    if (!l.startsWith("## Page ")) continue;
    const m = /^[0-9]+/.exec(l.slice(8));
    if (m) out.push(Number(m[0]));
  }
  return out;
}

function splitOnce(s: string, sep: string): [string, string] | null {
  const i = s.indexOf(sep);
  return i < 0 ? null : [s.slice(0, i), s.slice(i + sep.length)];
}

/** Pages of each flagged file in a mapping call's text, at most `max`, taken in turn from each file. */
export function pagesInChunk(seen: Seen, chunk: string, max: number): PageRef[] {
  const perFile: PageRef[][] = [];
  for (const block of chunk.split('<source path="').slice(1)) {
    const parts = splitOnce(block, '">');
    if (!parts) continue;
    const [label, body] = parts;
    const q = quality(seen, label);
    if (!q) continue;
    const flagged = picturePages(q);
    if (!flagged.length) continue;
    const shown = pageNumbersIn(body);
    let pages = flagged.filter((p) => shown.includes(p));
    if (!pages.length) pages = flagged.slice(0, 2);
    perFile.push(pages.map((p) => [label, p] as PageRef));
  }
  return roundRobin(perFile, max);
}

/** The flagged pages the passages of a writing request come from, at most `max`, a file at a time in turn. */
export function pagesOfPassages(seen: Seen, files: CourseFile[], material: string, max: number): PageRef[] {
  const perFile = new Map<string, PageRef[]>();
  const cleaned = new Map<string, string>();
  for (const block of material.split('<source path="').slice(1)) {
    const parts = splitOnce(block, '">');
    if (!parts) continue;
    const [label, rest] = parts;
    const q = quality(seen, label);
    if (!q) continue;
    const flagged = picturePages(q);
    if (!flagged.length) continue;
    const f = files.find((x) => x.label === label);
    if (!f) continue;
    let c = cleaned.get(f.label);
    if (c === undefined) {
      c = clean(f.text);
      cleaned.set(f.label, c);
    }
    const body = (rest.split("</source>")[0] ?? "").trim();
    const head = cutBytes(body, 80);
    const pages: number[] = [];
    const at = c.indexOf(head);
    if (at >= 0) {
      const p = pageAt(c, at);
      if (p !== null) pages.push(p);
    }
    pages.push(...pageNumbersIn(body));
    const list = perFile.get(label) ?? [];
    for (const p of pages.filter((x) => flagged.includes(x))) if (!list.some(([, x]) => x === p)) list.push([label, p]);
    perFile.set(label, list);
  }
  const keys = [...perFile.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return roundRobin(
    keys.map((k) => perFile.get(k)!),
    max,
  );
}

/** One from each list in turn, until `max`. */
export function roundRobin(lists: PageRef[][], max: number): PageRef[] {
  const out: PageRef[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const l of lists) {
      if (out.length >= max) return out;
      const p = l[i];
      if (!p) continue;
      const key = `${p[0]}\u0000${p[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/** One exam's share of the flagged pages. */
export type ExamMaterial = { title: string; pages: number; alert?: Alert };

/** What Study shows about a course's material and the space's model. */
export type MaterialView = { lines: string[]; pages: number; sight: Sight; alert?: Alert; exams: ExamMaterial[] };

/** Topics a scope covers (same rule as scope's `in_scope`). */
function inScope(map: ScopeMap, exam: ExamScope | null): Topic[] {
  return map.topics.filter((t) => !t.reference && (!exam || (exam.includes.includes(t.id) && !exam.excludes.includes(t.id))));
}

/** The flagged pages an exam's material leans on; without a map or a known scope, every flagged page. */
export function examPages(report: Report, folder: string, map: ScopeMap | null, exam: ExamScope | null): number {
  const total = () => report.files.reduce((n, f) => n + weight(f), 0);
  if (!map || !exam || !exam.known) return total();
  const prefix = `courses/${folder}/`;
  const rel = (label: string) => (label.startsWith(prefix) ? label.slice(prefix.length) : null);
  const inside = new Set<string>();
  for (const t of inScope(map, exam)) for (const e of t.evidence) if (rel(e.source) !== null) inside.add(rel(e.source)!);
  const cited = new Set<string>();
  for (const t of map.topics) for (const e of t.evidence) if (rel(e.source) !== null) cited.add(rel(e.source)!);
  return report.files.filter((f) => inside.has(f.path) || !cited.has(f.path)).reduce((n, f) => n + weight(f), 0);
}

/** Everything Study shows about `seen`'s material for a person whose model is `sight`. */
export function view(seen: Seen, map: ScopeMap | null, exams: ExamScope[], sight: Sight): MaterialView | null {
  const report = reportOf(seen);
  if (!report) return null;
  const s = summarise(report, () => true);
  const pages = report.files.reduce((n, f) => n + weight(f), 0);
  const examViews: ExamMaterial[] = exams.map((e) => {
    const n = examPages(report, folderOf(seen), map, e);
    const a = alert(n, `${e.title}’s material`, sight);
    return a ? { title: e.title, pages: n, alert: a } : { title: e.title, pages: n };
  });
  const a = alert(pages, "this course", sight);
  const out: MaterialView = { lines: s.lines, pages, sight, exams: examViews };
  if (a) out.alert = a;
  return out;
}
