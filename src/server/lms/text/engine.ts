import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { OCR_DPI, OCR_MAX_SIDE } from "./constants.ts";
import { closePdf, openPdf, renderGrey, type PdfDocument } from "./pdf.ts";
import { pagePicture } from "./pictures.ts";
import { PdfDoc } from "./pdfobj.ts";

/**
 * Text recognition engines, always on this computer (nothing leaves it): the
 * system `tesseract` program when it is installed, else tesseract.js with its
 * English data shipped in the app. A page's picture is the PDF's stored
 * picture when it has one, else drawn by poppler's `pdftoppm` when installed,
 * else drawn by pdfjs. Runs inside the recogniser child (ocr.ts).
 */

const RUN_LIMIT_MS = 80_000;
const OUT_MAX = 64 * 1024 * 1024;
const DPI = "300";

export const INSTALL =
  "reading handwriting and scans needs the free tesseract program: install it (for example “sudo apt install tesseract-ocr”, or “sudo dnf install tesseract”), then import the course again";

const require = createRequire(import.meta.url);

/** A program on PATH or in the usual places (an app started from a desktop menu may have a short PATH). */
export function find(name: string): string | null {
  const onPath = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const usual = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/snap/bin"];
  const exe = process.platform === "win32" ? [name, `${name}.exe`] : [name];
  for (const dir of [...onPath, ...usual]) {
    for (const n of exe) {
      const p = path.join(dir, n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Runs `bin` with `args`, `input` on stdin; its stdout. Killed after 80 s. */
export function run(bin: string, args: string[], input: Buffer | null, limitMs = RUN_LIMIT_MS): Promise<Buffer> {
  const name = path.basename(bin);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      reject(new Error(`${name} couldn’t start (${(e as Error).message})`));
      return;
    }
    const out: Buffer[] = [];
    let outLen = 0;
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      reject(new Error(`${name} took too long`));
    }, limitMs);
    child.stdout!.on("data", (c: Buffer) => {
      if (outLen < OUT_MAX) {
        out.push(c.subarray(0, OUT_MAX - outLen));
        outLen += c.length;
      }
    });
    child.stderr!.on("data", (c: Buffer) => {
      if (err.length < 4096) err += c.toString("utf8").slice(0, 4096 - err.length);
    });
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`${name} couldn’t start (${e.message})`));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        const last = err
          .split("\n")
          .map((l) => l.trim())
          .reverse()
          .find((l) => l !== "");
        reject(new Error(`${name}: ${last ? [...last].slice(0, 160).join("") : "it stopped"}`));
        return;
      }
      resolve(Buffer.concat(out));
    });
    if (input && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

function tidyLines(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\r$/, "").replace(/[\s\u0085]+$/u, ""))
    .filter((l) => l.trim() !== "")
    .join("\n");
}

/** The text the tesseract program recognises in a picture, line by line. */
export async function recogniseWith(tesseract: string, image: Buffer): Promise<string> {
  const out = await run(tesseract, ["stdin", "stdout"], image);
  return tidyLines(out.toString("utf8"));
}

/** Page `n` of the PDF at `file` drawn by pdftoppm, in grey, as a PNG. */
export async function drawPage(pdftoppm: string, file: string, n: number): Promise<Buffer> {
  const png = await run(pdftoppm, ["-f", String(n), "-l", String(n), "-r", DPI, "-gray", "-png", file], null);
  if (png.length >= 4 && png[0] === 0x89 && png.subarray(1, 4).toString("latin1") === "PNG") return png;
  throw new Error("pdftoppm drew nothing");
}

/** Where tesseract.js's English data is, when it ships with the app. */
function bundledLanguage(): string | null {
  try {
    const dir = path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
    require.resolve("tesseract.js");
    return fs.existsSync(path.join(dir, "eng.traineddata.gz")) ? dir : null;
  } catch {
    return null;
  }
}

export type Engine = { kind: "tesseract"; bin: string } | { kind: "tesseract.js"; langPath: string };

let engineCache: Engine | null | undefined;

/** The engine this computer has, or null. */
export function engine(): Engine | null {
  if (engineCache !== undefined) return engineCache;
  if (process.env.PHAETHON_OCR_ENGINE === "none") return (engineCache = null);
  const bin = process.env.PHAETHON_OCR_ENGINE === "tesseract.js" ? null : find("tesseract");
  if (bin) return (engineCache = { kind: "tesseract", bin });
  const langPath = bundledLanguage();
  return (engineCache = langPath ? { kind: "tesseract.js", langPath } : null);
}

/** null when recognition works here; otherwise what it needs, in the person's words. */
export function availability(): string | null {
  return engine() ? null : INSTALL;
}

type JsWorker = { recognize(image: Buffer): Promise<{ data: { text: string } }>; terminate(): Promise<unknown> };
let jsWorker: Promise<JsWorker> | undefined;

async function recogniseJs(langPath: string, image: Buffer): Promise<string> {
  jsWorker ??= (async () => {
    const t = require("tesseract.js") as { createWorker(lang: string, oem: number, options: Record<string, unknown>): Promise<JsWorker> };
    return t.createWorker("eng", 1, { langPath, cacheMethod: "none", gzip: true, logger: () => {}, errorHandler: () => {} });
  })();
  const w = await jsWorker;
  try {
    const r = await w.recognize(image);
    return tidyLines(r.data.text ?? "");
  } catch (e) {
    throw new Error(`text recognition failed (${String((e as Error)?.message ?? e)})`);
  }
}

/** Stops tesseract.js's worker so the child can exit. */
export async function closeEngine(): Promise<void> {
  if (!jsWorker) return;
  const w = await jsWorker.catch(() => null);
  jsWorker = undefined;
  await w?.terminate().catch(() => {});
}

export async function recognise(image: Buffer): Promise<string> {
  const e = engine();
  if (!e) throw new Error(INSTALL);
  return e.kind === "tesseract" ? recogniseWith(e.bin, image) : recogniseJs(e.langPath, image);
}

/** A PDF being recognised page by page. */
export class OcrPdf {
  private constructor(
    private readonly file: string,
    private readonly doc: PdfDocument,
    private readonly raw: PdfDoc | null,
    private readonly pdftoppm: string | null,
  ) {}

  static async open(file: string): Promise<OcrPdf> {
    if (!engine()) throw new Error(INSTALL);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch (e) {
      throw new Error(`the file couldn’t be read (${(e as Error).message})`);
    }
    let doc: PdfDocument;
    try {
      doc = await openPdf(bytes);
    } catch (e) {
      const m = (e as Error).message;
      throw new Error(m === "the PDF is password protected" ? m : "it couldn’t be opened as a PDF");
    }
    let raw: PdfDoc | null = null;
    try {
      raw = PdfDoc.load(bytes);
    } catch {
      raw = null;
    }
    const e = engine();
    return new OcrPdf(file, doc, raw, e?.kind === "tesseract" ? find("pdftoppm") : null);
  }

  /** The page's picture: as stored in the PDF, else drawn. */
  async pageImage(n: number): Promise<Buffer> {
    if (n < 1 || n > this.doc.numPages) throw new Error("there is no such page");
    const ref = this.raw?.pages[n - 1];
    if (this.raw && ref) {
      const stored = pagePicture(this.raw, ref);
      if (stored) return stored.bytes;
    }
    if (this.pdftoppm) return drawPage(this.pdftoppm, this.file, n);
    try {
      const png = await renderGrey(this.doc, n, OCR_DPI, OCR_MAX_SIDE);
      if (png) return png;
    } catch {
      // fall through
    }
    throw new Error("the page couldn’t be drawn");
  }

  async pageText(n: number): Promise<string> {
    return recognise(await this.pageImage(n));
  }

  async close(): Promise<void> {
    await closePdf(this.doc);
  }
}

/** The text of a picture file. */
export async function pictureText(file: string): Promise<string> {
  if (!engine()) throw new Error(INSTALL);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (e) {
    throw new Error(`it couldn’t be read (${(e as Error).message})`);
  }
  if (engine()?.kind === "tesseract.js" && !looksLikePicture(bytes)) throw new Error("it couldn’t be read as a picture");
  return recognise(bytes);
}

/** The picture formats tesseract.js reads, by their first bytes. */
function looksLikePicture(b: Buffer): boolean {
  const s = b.subarray(0, 12).toString("latin1");
  return (
    s.startsWith("\x89PNG") ||
    (b[0] === 0xff && b[1] === 0xd8) ||
    s.startsWith("BM") ||
    s.startsWith("GIF8") ||
    s.startsWith("II*\0") ||
    s.startsWith("MM\0*") ||
    (s.startsWith("RIFF") && s.slice(8, 12) === "WEBP")
  );
}
