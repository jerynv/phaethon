import fs from "node:fs";
import { letters, MAX_READ, PICTURE_BYTES, PICTURE_DPI, PICTURE_SIDE, PICTURES_MAX, SPARSE } from "./constants.ts";
import { closePdf, openPdf, pageText, renderGrey } from "./pdf.ts";
import { pagePicture } from "./pictures.ts";
import { PdfDoc } from "./pdfobj.ts";
import { pngSizeOf } from "./png.ts";

export type PagePicture = { page: number; mime: "image/png" | "image/jpeg"; data: string };

/**
 * The pictures of `pages` of the PDF at `file`, in this process (the child):
 * a scanned page's picture as stored when it is small enough, otherwise the
 * whole page drawn in grey (on every platform). Nothing for pages that can't be had.
 */
export async function pagePicturesHere(file: string, pages: number[]): Promise<PagePicture[]> {
  let bytes: Buffer;
  try {
    if (fs.statSync(file).size > MAX_READ) return [];
    bytes = fs.readFileSync(file);
  } catch {
    return [];
  }
  let doc;
  try {
    doc = await openPdf(bytes);
  } catch {
    return [];
  }
  let raw: PdfDoc | null = null;
  try {
    raw = PdfDoc.load(bytes);
  } catch {
    raw = null;
  }
  const out: PagePicture[] = [];
  try {
    for (const p of pages.slice(0, PICTURES_MAX)) {
      if (p < 1 || p > doc.numPages) continue;
      let typed = false;
      try {
        const page = await doc.getPage(p);
        typed = letters(await pageText(page)) >= SPARSE;
      } catch {
        typed = false;
      }
      const ref = raw?.pages[p - 1];
      const stored = !typed && raw && ref ? pagePicture(raw, ref) : null;
      const small = (b: Buffer) => {
        const size = pngSizeOf(b);
        return b.length <= PICTURE_BYTES && size !== null && Math.max(size[0], size[1]) <= 2 * PICTURE_SIDE;
      };
      let picked: { mime: PagePicture["mime"]; bytes: Buffer } | null = null;
      if (stored && small(stored.bytes)) picked = stored;
      else {
        let drawn: Buffer | null = null;
        try {
          drawn = await renderGrey(doc, p, PICTURE_DPI, PICTURE_SIDE);
        } catch {
          drawn = null;
        }
        if (drawn) picked = { mime: "image/png", bytes: drawn };
        else if (stored && stored.bytes.length <= PICTURE_BYTES) picked = stored;
      }
      if (picked) out.push({ page: p, mime: picked.mime, data: picked.bytes.toString("base64") });
    }
  } finally {
    await closePdf(doc);
  }
  return out;
}
