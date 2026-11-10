import fs from "node:fs";
import path from "node:path";
import { ChildError, runChild } from "./child-process.ts";
import {
  CANT_RECOGNISE,
  letters,
  MAX_OCR_PAGES,
  MAX_READ,
  MAX_TEXT,
  NO_OCR,
  NO_OCR_PICTURE,
  NO_TEXT_COPY,
  NO_TEXT_IN_PICTURE,
  OLD_NO_TEXT,
  PDF_TIMEOUT_MS,
  PICTURE_BYTES,
  PICTURES_MAX,
  PICTURES_NOTE,
  PICTURES_TIMEOUT_MS,
  RECOGNISED,
  SPARSE,
} from "./constants.ts";
import { availability } from "./engine.ts";
import { docxText, pptxText } from "./office.ts";
import { isPicture, recognise, type OcrPage } from "./ocr.ts";
import type { PagePicture } from "./page-pictures.ts";
import type { Layer } from "./pdf.ts";

/**
 * Text copies of course documents (PDF, Word, PowerPoint, pictures), so the
 * agent can read the actual material. PDFs are read and pictures recognised
 * in a child process (child.ts), killed after a time limit and capped.
 */

export { CANT_RECOGNISE, letters, NO_TEXT_COPY, NO_TEXT_IN_PICTURE, OLD_NO_TEXT, PICTURES_NOTE, RECOGNISED, SPARSE };
export { pngSizeOf, encodePng } from "./png.ts";
export { isPicture } from "./ocr.ts";
export type { Layer, PagePicture, OcrPage };

export type Doc = "pdf" | "docx" | "pptx" | "picture" | "other";

/** What kind of document a file is, by its extension. */
export function kindOf(file: string): Doc {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "pptx") return "pptx";
  if (isPicture(file)) return "picture";
  return "other";
}

/** null when text recognition works on this computer; otherwise what it needs, in words for the person. */
export function ocrAvailability(): string | null {
  return availability();
}

const CANCELLED = "cancelled";

function cancelled(signal?: AbortSignal): boolean {
  return !!signal?.aborted;
}

function readCapped(file: string): Buffer {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch (e) {
    throw new Error((e as Error).message);
  }
  if (size > MAX_READ) throw new Error("too big to read");
  return fs.readFileSync(file);
}

/**
 * The text of the document at `file` ("" for a document with no text), or
 * why there is none. Stops as soon as `signal` aborts, rejecting with
 * "cancelled", so no half-made copy is written.
 */
/**
 * A document's text, by its extension, or as `as` says when the caller knows
 * the type already (an attachment named without its extension).
 */
export async function extract(file: string, signal?: AbortSignal, as?: "pdf"): Promise<string> {
  if (cancelled(signal)) throw new Error(CANCELLED);
  let r: string;
  try {
    r = as === "pdf" ? await pdfText(file, signal) : await extractInner(file, signal);
  } catch (e) {
    if (cancelled(signal)) throw new Error(CANCELLED);
    throw e instanceof Error ? new Error(e.message) : new Error(String(e));
  }
  if (cancelled(signal)) throw new Error(CANCELLED);
  return r;
}

async function extractInner(file: string, signal?: AbortSignal): Promise<string> {
  switch (kindOf(file)) {
    case "pdf":
      return pdfText(file, signal);
    case "docx":
      return docxText(readCapped(file));
    case "pptx":
      return pptxText(readCapped(file));
    case "picture":
      return pictureText(file, signal);
    default:
      throw new Error("not a document Phaethon can read");
  }
}

/** Each page's text layer and pictures, no recognition, read in the text child. */
export async function pdfLayers(file: string, signal?: AbortSignal): Promise<Layer[]> {
  let out: Buffer;
  try {
    out = await runChild("pdf-text", [path.resolve(file)], PDF_TIMEOUT_MS, 2 * MAX_TEXT + 1, signal, {
      start: "couldn’t start the PDF reader",
      slow: "reading the PDF took too long",
      failed: "the PDF couldn’t be read",
    });
  } catch (e) {
    throw new Error(e instanceof ChildError ? e.message : String((e as Error).message));
  }
  try {
    const v = JSON.parse(out.toString("utf8")) as Layer[];
    if (!Array.isArray(v)) throw new Error("not a list");
    return v.map((l) => ({ page: Number(l.page), text: String(l.text ?? ""), pictures: Number(l.pictures ?? 0) }));
  } catch {
    throw new Error("the PDF’s text was too long or couldn’t be read");
  }
}

async function pdfText(file: string, signal?: AbortSignal): Promise<string> {
  const pages = await pdfLayers(file, signal);
  const sparse = pages
    .filter((l) => letters(l.text) < SPARSE)
    .map((l) => l.page)
    .slice(0, MAX_OCR_PAGES);
  const can = availability();
  let recognised = new Map<number, OcrPage>();
  if (sparse.length && can === null) {
    recognised = await recognise(path.resolve(file), sparse, signal);
    if (cancelled(signal)) throw new Error(CANCELLED);
  }
  return assemble(pages, recognised, can);
}

/** The note under a typed page that also shows pictures. */
function picturesNote(n: number): string {
  return n === 1
    ? `${PICTURES_NOTE}a picture (a figure, diagram or photo); it can’t be read as text.)`
    : `${PICTURES_NOTE}${n} pictures (figures, diagrams or photos); they can’t be read as text.)`;
}

const trimWs = (s: string) => s.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, "");

/**
 * The text copy of a PDF: each page's text layer, or for a page with (almost)
 * none, what was recognised from its picture, marked as such. `can` is null
 * when recognition works here, else why not.
 */
export function assemble(pages: Layer[], recognised: Map<number, OcrPage>, can: string | null): string {
  let out = "";
  for (const l of pages) {
    const n = l.page;
    const layer = l.text;
    const r = recognised.get(n);
    let label = "";
    let body: string;
    if (r && "text" in r && letters(r.text) > letters(layer)) {
      label = ` ${RECOGNISED}`;
      body = trimWs(r.text);
    } else if (r && "text" in r && layer === "") body = "(No text was found on this page.)";
    else if (r && "failed" in r && layer === "") body = `(This page is handwriting or a scan, and its text couldn’t be recognised: ${r.failed}.)`;
    else if (!r && layer === "")
      body = can !== null ? `(This page is handwriting or a scan, and ${CANT_RECOGNISE} ${can}.)` : `(This page has no text, and only the first ${MAX_OCR_PAGES} such pages are recognised.)`;
    else body = layer;
    const typed = label === "" && letters(layer) >= SPARSE;
    const note = typed && l.pictures > 0 ? `\n\n${picturesNote(l.pictures)}` : "";
    out += `## Page ${n}${label}\n\n${body}${note}\n\n`;
  }
  return out.replace(/[\s\u0085]+$/u, "");
}

/** A text copy of a picture: whatever text was recognised in it. */
async function pictureText(file: string, signal?: AbortSignal): Promise<string> {
  const why = availability();
  if (why !== null) return `(This is a picture, and ${CANT_RECOGNISE} ${why}.)`;
  const r = (await recognise(path.resolve(file), null, signal)).get(1);
  if (cancelled(signal)) throw new Error(CANCELLED);
  if (r && "text" in r && r.text.trim() !== "") return `## Picture ${RECOGNISED}\n\n${trimWs(r.text)}`;
  if (r && "text" in r) return NO_TEXT_IN_PICTURE;
  if (r && "failed" in r) return `(Any text in this picture couldn’t be recognised: ${r.failed}.)`;
  return "(Any text in this picture couldn’t be recognised.)";
}

/**
 * `copy` (a PDF's text copy) with each typed page's note about its pictures as
 * `layers` count them now; null when every note already says so. Only those
 * notes change: recognised text, a person's edits and the heading stay.
 */
export function withPictureNotes(copy: string, layers: Layer[]): string | null {
  const want = new Map<number, number>();
  for (const l of layers) if (letters(l.text) >= SPARSE) want.set(l.page, l.pictures);
  const lines = copy.split("\n");
  const out: string[] = [];
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    i++;
    if (!line.startsWith("## Page ")) continue;
    const rest = line.slice("## Page ".length);
    let end = lines.length;
    for (let k = i; k < lines.length; k++)
      if (lines[k].startsWith("## ")) {
        end = k;
        break;
      }
    const body = lines.slice(i, end);
    let trailing = 0;
    for (let k = body.length - 1; k >= 0 && body[k].trim() === ""; k--) trailing++;
    body.length -= trailing;
    let old: string | null = null;
    if (body.length && body[body.length - 1].startsWith(PICTURES_NOTE)) {
      old = body.pop()!;
      while (body.length && body[body.length - 1].trim() === "") body.pop();
    }
    const first = rest.split(/\s+/u).filter(Boolean)[0];
    const page = first !== undefined && /^\d+$/.test(first) ? Number(first) : null;
    const count = page !== null && !rest.includes(RECOGNISED) ? want.get(page) : undefined;
    const fresh = count !== undefined && count > 0 ? picturesNote(count) : null;
    if (old !== fresh) changed = true;
    out.push(...body);
    if (fresh !== null) out.push("", fresh);
    for (let k = 0; k < trailing; k++) out.push("");
    i = end;
  }
  return changed ? out.join("\n") : null;
}

/**
 * True when a text copy is missing pages and should be made again: there is
 * none; it was made before pages could be recognised (or on a computer that
 * couldn't, now read on one that can); or a page heading has nothing under it.
 *
 * The "no text in it" note is stale only on a PDF's or picture's copy, where
 * today's copies are page by page (an old copy of a scan said only that); on
 * a Word or PowerPoint copy it is current, so an empty document isn't read
 * again on every import.
 */
export function copyIsStale(mdPath: string): boolean {
  let copy: string;
  try {
    copy = fs.readFileSync(mdPath, "utf8");
  } catch {
    return true;
  }
  const original = mdPath.endsWith(".md") ? mdPath.slice(0, -3) : mdPath;
  const pageByPage = kindOf(original) === "pdf" || kindOf(original) === "picture";
  if (copy.includes(OLD_NO_TEXT) && (pageByPage || !copy.includes(NO_TEXT_COPY))) return true;
  if (availability() === null && (copy.includes(NO_OCR) || copy.includes(NO_OCR_PICTURE) || copy.includes(CANT_RECOGNISE))) return true;
  let emptyPage = false;
  const lines = copy.split("\n");
  if (copy.endsWith("\n")) lines.pop();
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("## ")) {
      if (emptyPage) return true;
      emptyPage = line.startsWith("## Page ");
    } else if (line.trim() !== "") emptyPage = false;
  }
  return emptyPage;
}

/**
 * The pictures of `pages` of the PDF at `file`, for a model that can look at
 * them: a scanned page's stored picture when small enough, otherwise the page
 * drawn. Read in the text child; never throws (nothing when they can't be had).
 */
export async function pagePictures(file: string, pages: number[], signal?: AbortSignal): Promise<PagePicture[]> {
  if (!pages.length) return [];
  const list = pages.slice(0, PICTURES_MAX).join(",");
  try {
    const out = await runChild("page-pictures", [path.resolve(file), "--pages", list], PICTURES_TIMEOUT_MS, PICTURES_MAX * PICTURE_BYTES * 2, signal, {
      start: "couldn’t start the PDF reader",
      slow: "drawing the pages took too long",
      failed: "the PDF couldn’t be drawn",
    });
    const v = JSON.parse(out.toString("utf8")) as PagePicture[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
