import path from "node:path";
import { createInterface } from "node:readline";
import { childCommand, startChild, type ChildSpec } from "./child-process.ts";
import { FILE_TIMEOUT_MS, MAX_OCR_PAGES, MAX_PAGE_TEXT, PAGE_TIMEOUT_MS } from "./constants.ts";

/**
 * Text recognition runs in a child process: the child prints one JSON line
 * per page as it finishes; the parent kills it when a page takes longer than
 * the page limit and starts a new one for the pages left, until the file's
 * time runs out.
 */

/** What became of one page: recognised text (possibly empty), or why it couldn't be recognised. */
export type OcrPage = { text: string } | { failed: string };

const PICTURE_EXTS = new Set(["png", "jpg", "jpeg", "heic", "heif", "tif", "tiff", "gif", "webp", "bmp"]);

/** Picture files a text copy is made for by recognising their text. */
export function isPicture(file: string): boolean {
  return PICTURE_EXTS.has(path.extname(file).slice(1).toLowerCase());
}

/** Keeps at most 256 KiB of a page's text, cut at a character boundary. */
function cap(t: string): string {
  const b = Buffer.from(t, "utf8");
  if (b.length <= MAX_PAGE_TEXT) return t;
  let cut = MAX_PAGE_TEXT;
  while (cut > 0 && (b[cut] & 0xc0) === 0x80) cut--;
  return b.subarray(0, cut).toString("utf8");
}

export type Make = (left: number[]) => ChildSpec;

/**
 * Runs children made by `make` (given the pages still to do) until every page
 * has an answer: a page that takes longer than `pageLimitMs`, or that the
 * child dies on, is marked failed and the next child starts after it.
 */
export async function supervise(make: Make, pages: number[], pageLimitMs: number, fileLimitMs: number, signal?: AbortSignal): Promise<Map<number, OcrPage>> {
  const started = Date.now();
  const left = [...pages];
  const out = new Map<number, OcrPage>();
  while (left.length && !signal?.aborted) {
    const budget = fileLimitMs - (Date.now() - started);
    if (budget < 0) break;
    const c = make(left);
    const child = startChild(c);
    const spawned = await new Promise<Error | null>((resolve) => {
      child.once("spawn", () => resolve(null));
      child.once("error", (e) => resolve(e));
    });
    if (spawned) {
      const why = `text recognition couldn’t start (${spawned.message})`;
      for (const p of left.splice(0)) out.set(p, { failed: why });
      break;
    }
    child.stderr?.resume();
    const queue: string[] = [];
    let closed = false;
    let wake: (() => void) | null = null;
    const poke = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    let read = 0;
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (l) => {
      read += Buffer.byteLength(l) + 1;
      if (read <= MAX_OCR_PAGES * MAX_PAGE_TEXT) queue.push(l);
      poke();
    });
    lines.on("close", () => {
      closed = true;
      poke();
    });
    const onAbort = () => poke();
    signal?.addEventListener("abort", onAbort);
    const deadline = Date.now() + budget;
    let pageDeadline = Date.now() + pageLimitMs;
    let whyStopped: string | null = null;
    for (;;) {
      if (signal?.aborted) {
        whyStopped = "cancelled";
        break;
      }
      const until = Math.min(pageDeadline, deadline);
      const now = Date.now();
      if (now >= until) {
        whyStopped = "recognising its text took too long";
        break;
      }
      const raw = queue.shift();
      if (raw === undefined) {
        if (closed) {
          whyStopped = "text recognition stopped on it";
          break;
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            wake = null;
            resolve();
          }, Math.min(until - now, 100));
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        continue;
      }
      let l: { page?: unknown; text?: unknown; error?: unknown };
      try {
        l = JSON.parse(raw.trim());
      } catch {
        continue;
      }
      const at = left.indexOf(l.page as number);
      if (at < 0) continue;
      left.splice(at, 1);
      const page: OcrPage = typeof l.error === "string" ? { failed: l.error } : typeof l.text === "string" ? { text: cap(l.text) } : { text: "" };
      out.set(l.page as number, page);
      pageDeadline = Date.now() + pageLimitMs;
      if (!left.length) break;
    }
    signal?.removeEventListener("abort", onAbort);
    child.kill();
    lines.close();
    child.stdout?.destroy();
    child.stderr?.destroy();
    // The child works in order, so the page it stopped on is the first one left.
    if (whyStopped && whyStopped !== "cancelled" && left.length) out.set(left.shift()!, { failed: whyStopped });
  }
  const why = signal?.aborted ? "the import was cancelled" : "there wasn’t time to recognise its text";
  for (const p of left) out.set(p, { failed: why });
  return out;
}

/**
 * Recognises `pages` of the PDF at `file` (or, with `pages` null, the picture
 * at `file`, reported as page 1) in the text child.
 */
export function recognise(file: string, pages: number[] | null, signal?: AbortSignal): Promise<Map<number, OcrPage>> {
  const wanted = pages ?? [1];
  return supervise(
    (left) => childCommand("ocr", pages ? [file, "--pages", left.join(",")] : [file]),
    wanted,
    PAGE_TIMEOUT_MS,
    FILE_TIMEOUT_MS,
    signal,
  );
}
