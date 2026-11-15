import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { letters, MAX_TEXT, SPARSE } from "./constants.ts";
import { contentCounts, drawn, type Drawn } from "./pictures.ts";
import { encodePng } from "./png.ts";
import { PdfDoc } from "./pdfobj.ts";

/**
 * PDF reading with pdfjs (text layers, page drawing), run only inside the
 * text child process: a PDF from the internet can be malformed in ways that
 * make a parser spin or eat memory, and the child is killed and capped.
 */

export type Layer = { page: number; text: string; pictures: number };

// pdfjs is loaded on first use and typed only as far as used here.
type TextItem = { str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number };
export type PdfPage = {
  getTextContent(): Promise<{ items: TextItem[] }>;
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: { canvasContext: unknown; viewport: unknown; canvas: unknown; background?: string }): { promise: Promise<void> };
  cleanup(): void;
};
export type PdfDocument = {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  loadingTask: { destroy(): Promise<void> };
  canvasFactory: { create(w: number, h: number): { canvas: { width: number; height: number }; context: CanvasContext } };
};
type CanvasContext = {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
};

const require = createRequire(import.meta.url);

let pdfjsPromise: Promise<{ getDocument(o: Record<string, unknown>): { promise: Promise<PdfDocument> } }> | undefined;

function pdfjs() {
  pdfjsPromise ??= import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href) as never;
  return pdfjsPromise!;
}

function pdfjsDir(sub: string): string {
  return path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), sub).replaceAll(path.sep, "/") + "/";
}

/** Opens a PDF; errors come back in the copy's words. */
export async function openPdf(bytes: Uint8Array): Promise<PdfDocument> {
  const lib = await pdfjs();
  try {
    return await lib.getDocument({
      data: new Uint8Array(bytes),
      verbosity: 0,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      standardFontDataUrl: pdfjsDir("standard_fonts"),
      cMapUrl: pdfjsDir("cmaps"),
      cMapPacked: true,
      wasmUrl: pdfjsDir("wasm"),
      iccUrl: pdfjsDir("iccs"),
    }).promise;
  } catch (e) {
    const err = e as Error;
    if (err?.name === "PasswordException") throw new Error("the PDF is password protected");
    throw new Error(`it couldn’t be read as a PDF (${err?.message ?? String(e)})`);
  }
}

/** Frees a document and its worker. */
export async function closePdf(doc: PdfDocument): Promise<void> {
  await doc.loadingTask.destroy().catch(() => {});
}

/** A page's text layer as lines: items joined, a new line where the text says so or moves to another line. */
export async function pageText(page: PdfPage): Promise<string> {
  let items: TextItem[];
  try {
    items = (await page.getTextContent()).items;
  } catch {
    return "";
  }
  let out = "";
  let lastY: number | null = null;
  let lastEnd: number | null = null;
  let lastH = 0;
  for (const it of items) {
    const str = it.str ?? "";
    const t = it.transform ?? [1, 0, 0, 1, 0, 0];
    const x = t[4];
    const y = t[5];
    const h = Math.abs(it.height ?? 0) || Math.abs(t[3]) || 1;
    if (str !== "") {
      if (lastY !== null && Math.abs(y - lastY) > Math.max(h, lastH) * 0.5 && out !== "" && !out.endsWith("\n")) out += "\n";
      else if (lastEnd !== null && !out.endsWith("\n") && !out.endsWith(" ") && !str.startsWith(" ") && x - lastEnd > h * 0.2) out += " ";
      out += str;
      lastY = y;
      lastH = h;
      lastEnd = x + (it.width ?? 0);
    }
    if (it.hasEOL) {
      out += "\n";
      lastEnd = null;
    }
  }
  return out
    .split("\n")
    .map((l) => l.replace(/[\s\u0085]+$/u, ""))
    .join("\n")
    .replace(/^[\s\u0085]+|[\s\u0085]+$/gu, "");
}

/** Each page's text layer and how many content pictures it draws (decoration told apart across the document). */
export async function pdfPagesHere(bytes: Buffer): Promise<Layer[]> {
  const doc = await openPdf(bytes);
  let raw: PdfDoc | null = null;
  try {
    raw = PdfDoc.load(bytes);
  } catch {
    raw = null;
  }
  try {
    const out: Layer[] = [];
    const draws: Drawn[] = [];
    let size = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      let text = "";
      try {
        const page = await doc.getPage(p);
        text = await pageText(page);
        page.cleanup();
      } catch {
        text = "";
      }
      size += Buffer.byteLength(text);
      const ref = raw?.pages[p - 1];
      let d: Drawn = { pics: [], size: null, hasText: letters(text) >= SPARSE };
      if (raw && ref) {
        try {
          d = drawn(raw, ref, letters(text) >= SPARSE);
        } catch {
          // A page whose pictures can't be told apart counts none.
        }
      }
      draws.push(d);
      out.push({ page: p, text, pictures: 0 });
      if (size > MAX_TEXT) break;
    }
    contentCounts(draws).forEach((n, i) => {
      out[i].pictures = n;
    });
    return out;
  } finally {
    await closePdf(doc);
  }
}

/** Page `n` drawn in grey: width, height and one byte per pixel, rows top to bottom. Null when there is no such page. */
export async function renderGreyPixels(doc: PdfDocument, n: number, dpi: number, maxSide: number): Promise<{ w: number; h: number; grey: Buffer } | null> {
  if (n < 1 || n > doc.numPages) return null;
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const longest = Math.max(base.width, base.height) || 1;
  const scale = Math.min(dpi / 72, maxSide / longest);
  const vp = page.getViewport({ scale });
  const w = Math.max(1, Math.floor(vp.width));
  const h = Math.max(1, Math.floor(vp.height));
  const { canvas, context } = doc.canvasFactory.create(w, h);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, w, h);
  await page.render({ canvasContext: context, viewport: vp, canvas }).promise;
  const rgba = context.getImageData(0, 0, w, h).data;
  const grey = Buffer.alloc(w * h);
  for (let i = 0, j = 0; j < grey.length; i += 4, j++) grey[j] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  page.cleanup();
  return { w, h, grey };
}

/** Page `n` drawn in grey as a PNG at `dpi`, its longest side at most `maxSide` pixels. Null when there is no such page. */
export async function renderGrey(doc: PdfDocument, n: number, dpi: number, maxSide: number): Promise<Buffer | null> {
  const px = await renderGreyPixels(doc, n, dpi, maxSide);
  return px ? encodePng(px.w, px.h, 1, px.grey, false) : null;
}
