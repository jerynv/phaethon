/**
 * The text child: started by the core (child-process.ts) with
 * `--phaethon-text-child <mode> <file> [--pages 1,2]`, never selected by an
 * environment variable. A malformed PDF can only take this process down.
 *
 * - `pdf-text`: stdout is a JSON array of `{page, text, pictures}`; exit 0, 1
 *   (stdout failed) or 2 (unreadable; why on stderr).
 * - `ocr`: one JSON line per page as it finishes, `{page, text}` or `{page, error}`;
 *   a picture (no `--pages`) is page 1.
 * - `page-pictures`: stdout is a JSON array of `{page, mime, data}`.
 */
import fs from "node:fs";
import { CHILD_FLAG } from "./child-process.ts";
import { closeEngine, OcrPdf, pictureText } from "./engine.ts";
import { pagePicturesHere } from "./page-pictures.ts";
import { pdfPagesHere } from "./pdf.ts";
import { MAX_READ } from "./constants.ts";

function write(s: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(s, (e) => resolve(!e));
  });
}

async function main(argv: string[]): Promise<number> {
  const at = argv.indexOf(CHILD_FLAG);
  if (at < 0) return 64;
  const [mode, file] = argv.slice(at + 1);
  const p = argv.indexOf("--pages");
  const pages = p >= 0 ? (argv[p + 1] ?? "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0) : null;
  if (mode === "pdf-text") {
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_READ) throw new Error("too big to read");
      const layers = await pdfPagesHere(fs.readFileSync(file));
      return (await write(JSON.stringify(layers))) ? 0 : 1;
    } catch (e) {
      process.stderr.write(String((e as Error)?.message ?? e));
      return 2;
    }
  }
  if (mode === "ocr") {
    const emit = (page: number, r: { text: string } | { error: string }) => write(JSON.stringify({ page, ...r }) + "\n");
    const result = async (f: () => Promise<string>) => {
      try {
        return { text: await f() };
      } catch (e) {
        return { error: String((e as Error)?.message ?? e) };
      }
    };
    try {
      if (!pages) {
        await emit(1, await result(() => pictureText(file)));
        return 0;
      }
      let pdf: OcrPdf;
      try {
        pdf = await OcrPdf.open(file);
      } catch (e) {
        for (const n of pages) await emit(n, { error: String((e as Error).message) });
        return 0;
      }
      for (const n of pages) if (!(await emit(n, await result(() => pdf.pageText(n))))) return 1;
      await pdf.close();
      return 0;
    } finally {
      await closeEngine();
    }
  }
  if (mode === "page-pictures") {
    const pics = await pagePicturesHere(file, pages ?? []);
    return (await write(JSON.stringify(pics))) ? 0 : 1;
  }
  return 64;
}

main(process.argv).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(String((e as Error)?.message ?? e));
    process.exit(2);
  },
);
