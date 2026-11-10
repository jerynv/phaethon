import { createHash } from "node:crypto";
import { encodePng } from "./png.ts";
import { inflate, isName, isRef, isStream, operations, PdfDoc, type Obj, type Ref } from "./pdfobj.ts";

/**
 * The pictures a PDF page shows besides its text. A page's pictures are the
 * images its content stream actually draws: image XObjects named by `Do`
 * (also inside form XObjects, a few levels deep) and inline images, each
 * counted once. Resources shared by every page don't count for a page that
 * never draws them. Icons, bullets and rules are too small to count.
 *
 * `pagePicture` gives a page's main picture as a file without rendering: a
 * JPEG as it is stored, or grey and RGB pixels as a PNG.
 */

const MIN_SIDE = 48;
const MIN_PIXELS = 40_000;
const FORM_DEPTH = 3;
const MAX_CONTENT = 64 * 1024 * 1024;
const MAX_PIXELS_BYTES = 96 * 1024 * 1024;
const MIN_PAGE_SHARE = 0.02;
const BACKDROP_SHARE = 0.85;

export type Pic = {
  /** The image XObject's object number; null for an inline image. */
  id: number | null;
  width: number;
  height: number;
  /** Where it is drawn, in the page's points: [left, bottom, right, top]. */
  drawn: [number, number, number, number];
  /** Its stored bytes, hashed: the same picture drawn again (by the same object or a copy) hashes the same. */
  hash: string;
};

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m` then `c`, as PDF's `cm` concatenates. */
function concat(m: Matrix, c: Matrix): Matrix {
  return [m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3], m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3], m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5]];
}

function unitBox(m: Matrix): [number, number, number, number] {
  const pts = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function matrixOf(doc: PdfDoc, ops: Obj[]): Matrix | null {
  const n = ops.map((o) => doc.get(o)).filter((o): o is number => typeof o === "number");
  return n.length === 6 && n.every(Number.isFinite) ? (n as Matrix) : null;
}

function hashOf(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex").slice(0, 16);
}

export function counts(p: Pic): boolean {
  return p.width >= MIN_SIDE && p.height >= MIN_SIDE && p.width * p.height >= MIN_PIXELS;
}

function pageShare(p: Pic, w: number, h: number): number {
  const clip = (lo: number, hi: number, max: number) => Math.max(Math.min(hi, max) - Math.max(lo, 0), 0);
  return (clip(p.drawn[0], p.drawn[2], w) * clip(p.drawn[1], p.drawn[3], h)) / (w * h);
}

function samePlace(a: Pic, b: Pic, w: number, h: number): boolean {
  return [0, 1, 2, 3].every((i) => Math.abs(a.drawn[i] - b.drawn[i]) <= 0.02 * (i % 2 === 0 ? w : h));
}

function int(doc: PdfDoc, d: Map<string, Obj>, k: string): number | undefined {
  const v = doc.num(d.get(k));
  return v === undefined ? undefined : Math.trunc(v);
}

/** The XObject dictionaries a page's names are looked up in: its own, then those it inherits. */
function pageXObjects(doc: PdfDoc, page: Ref): Map<string, Obj>[] {
  const out: Map<string, Obj>[] = [];
  const seen = new Set<number>();
  let node: Map<string, Obj> | undefined = doc.dict(page);
  while (node) {
    const res = doc.dict(node.get("Resources"));
    const x = res ? doc.dict(res.get("XObject")) : undefined;
    if (x) out.push(x);
    const parent: Obj | undefined = node.get("Parent");
    if (!isRef(parent) || seen.has(parent.n) || seen.size >= 63) break;
    seen.add(parent.n);
    node = doc.dict(parent);
  }
  return out;
}

function walk(doc: PdfDoc, content: Buffer, xobjects: Map<string, Obj>[], depth: number, start: Matrix, seen: Set<number>, out: Pic[]): void {
  let ctm = start;
  const saved: Matrix[] = [];
  for (const op of operations(content)) {
    switch (op.op) {
      case "q":
        if (saved.length < 256) saved.push(ctm);
        break;
      case "Q":
        ctm = saved.pop() ?? ctm;
        break;
      case "cm": {
        const m = matrixOf(doc, op.args);
        if (m) ctm = concat(m, ctm);
        break;
      }
      case "Do": {
        const name = op.args[0];
        if (!isName(name)) break;
        let target: Obj | undefined;
        for (const x of xobjects) {
          if (x.has(name.v)) {
            target = x.get(name.v);
            break;
          }
        }
        if (!isRef(target) || seen.has(target.n)) break;
        seen.add(target.n);
        const stream = doc.get(target);
        if (!isStream(stream)) break;
        const d = stream.dict;
        const sub = doc.get(d.get("Subtype"));
        if (isName(sub, "Image")) {
          out.push({ id: target.n, width: int(doc, d, "Width") ?? 0, height: int(doc, d, "Height") ?? 0, drawn: unitBox(ctm), hash: hashOf(stream.data) });
        } else if (isName(sub, "Form") && depth < FORM_DEPTH) {
          const inner = doc.decoded(stream, MAX_CONTENT);
          if (!inner) break;
          const res = doc.dict(d.get("Resources"));
          const own = res ? doc.dict(res.get("XObject")) : undefined;
          const names = own ? [own, ...xobjects] : xobjects;
          const mObj = doc.get(d.get("Matrix"));
          const form = (Array.isArray(mObj) ? matrixOf(doc, mObj) : null) ?? IDENTITY;
          walk(doc, inner, names, depth + 1, concat(form, ctm), seen, out);
        }
        break;
      }
      case "BI": {
        if (!op.inline) break;
        const d = op.inline.dict;
        const w = int(doc, d, "W") ?? int(doc, d, "Width") ?? 0;
        const h = int(doc, d, "H") ?? int(doc, d, "Height") ?? 0;
        out.push({ id: null, width: w, height: h, drawn: unitBox(ctm), hash: hashOf(op.inline.data) });
        break;
      }
    }
  }
}

/** Every picture page `page` draws (decoration included; see `counts`). */
export function pagePictures(doc: PdfDoc, page: Ref): Pic[] {
  const content = doc.pageContent(page, MAX_CONTENT);
  if (!content) return [];
  const out: Pic[] = [];
  walk(doc, content, pageXObjects(doc, page), 0, IDENTITY, new Set(), out);
  return out;
}

function pageBox(doc: PdfDoc, page: Ref): [number, number, number, number] | null {
  let node: Obj | undefined = page;
  for (let i = 0; i < 16; i++) {
    const d = doc.dict(node);
    if (!d) return null;
    const b = doc.get(d.get("MediaBox"));
    if (Array.isArray(b)) {
      const n = b.map((x) => doc.get(x)).filter((x): x is number => typeof x === "number");
      if (n.length !== 4) return null;
      const box: [number, number, number, number] = [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
      return box[2] - box[0] > 0 && box[3] - box[1] > 0 ? box : null;
    }
    node = d.get("Parent");
    if (!isRef(node)) return null;
  }
  return null;
}

/** What one page draws, for `contentCounts`. */
export type Drawn = { pics: Pic[]; size: [number, number] | null; hasText: boolean };

export function drawn(doc: PdfDoc, page: Ref, hasText: boolean): Drawn {
  const b = pageBox(doc, page);
  const pics = pagePictures(doc, page)
    .filter(counts)
    .map((p) => (b ? { ...p, drawn: [p.drawn[0] - b[0], p.drawn[1] - b[1], p.drawn[2] - b[0], p.drawn[3] - b[1]] as Pic["drawn"] } : p));
  return { pics, size: b ? [b[2] - b[0], b[3] - b[1]] : null, hasText };
}

/**
 * How many pictures each page shows that are content (figures, diagrams,
 * photos), in order. Decoration by size, backdrops under a page's text, and a
 * template's repeated pictures (and ones the same size in the same place) don't count.
 */
export function contentCounts(pages: Drawn[]): number[] {
  const on = new Map<string, Set<number>>();
  pages.forEach((d, i) => {
    for (const p of d.pics) {
      if (!on.has(p.hash)) on.set(p.hash, new Set());
      on.get(p.hash)!.add(i);
    }
  });
  const n = pages.length;
  const repeated = (p: Pic) => n >= 3 && (on.get(p.hash)?.size ?? 0) * 2 > n;
  const template: [Pic, [number, number]][] = [];
  for (const d of pages) {
    if (!d.size) continue;
    for (const p of d.pics) if (repeated(p)) template.push([p, d.size]);
  }
  return pages.map(
    (d) =>
      d.pics.filter((p) => {
        if (repeated(p)) return false;
        if (!d.size) return true;
        const [w, h] = d.size;
        const share = pageShare(p, w, h);
        if (share < MIN_PAGE_SHARE) return false;
        if (d.hasText) {
          const pageShaped = Math.min(p.width, p.height) >= 900 && Math.abs(p.width / p.height - w / h) <= 0.08 * (w / h);
          if (share >= BACKDROP_SHARE || pageShaped) return false;
        }
        return !template.some(([t, s]) => t.width === p.width && t.height === p.height && s[0] === w && s[1] === h && samePlace(p, t, w, h));
      }).length,
  );
}

function channels(doc: PdfDoc, cs: Obj | undefined): number | null {
  const v = doc.get(cs);
  let name: string;
  if (isName(v)) name = v.v;
  else if (Array.isArray(v)) {
    const first = doc.get(v[0]);
    if (!isName(first)) return null;
    if (first.v === "ICCBased") {
      const s = doc.get(v[1]);
      if (!isStream(s)) return null;
      const n = int(doc, s.dict, "N");
      return n === 1 || n === 3 ? n : null;
    }
    name = first.v;
  } else return null;
  if (name === "DeviceGray" || name === "CalGray" || name === "G") return 1;
  if (name === "DeviceRGB" || name === "CalRGB" || name === "RGB") return 3;
  return null;
}

/**
 * A page's main picture (its largest that counts) as a file, or null when it
 * has none or it is stored in a way handed on only after rendering (CMYK,
 * JPEG 2000, fax compression, a palette, a mask).
 */
export function pagePicture(doc: PdfDoc, page: Ref): { mime: "image/jpeg" | "image/png"; bytes: Buffer } | null {
  let best: Pic | null = null;
  for (const p of pagePictures(doc, page)) {
    if (!counts(p) || p.id === null) continue;
    if (!best || p.width * p.height >= best.width * best.height) best = p;
  }
  if (!best || best.id === null) return null;
  const stream = doc.get(doc.object(best.id));
  if (!isStream(stream)) return null;
  const d = stream.dict;
  if (doc.get(d.get("ImageMask")) === true) return null;
  const filters = doc.filters(stream);
  const ch = channels(doc, d.get("ColorSpace"));
  const bpc = int(doc, d, "BitsPerComponent") ?? 8;
  if (filters.length === 1 && (filters[0] === "DCTDecode" || filters[0] === "DCT")) {
    if (ch === null && d.has("ColorSpace")) return null;
    return stream.data[0] === 0xff && stream.data[1] === 0xd8 ? { mime: "image/jpeg", bytes: Buffer.from(stream.data) } : null;
  }
  if (filters.length <= 1 && bpc === 8) {
    if (ch === null) return null;
    if (filters.length === 1 && filters[0] !== "FlateDecode" && filters[0] !== "Fl") return null;
    const { width: w, height: h } = best;
    if (w <= 0 || h <= 0) return null;
    const need = w * h * ch;
    if (need > MAX_PIXELS_BYTES) return null;
    const parms = doc.dict(d.get("DecodeParms"));
    const predictor = parms ? (int(doc, parms, "Predictor") ?? 1) : 1;
    const raw = filters.length === 0 ? stream.data : inflate(stream.data, need + h + 1024);
    if (!raw) return null;
    let png: Buffer | null = null;
    if (predictor === 1) png = encodePng(w, h, ch, raw, false);
    else if (predictor >= 10 && predictor <= 15) png = encodePng(w, h, ch, raw, true);
    return png ? { mime: "image/png", bytes: png } : null;
  }
  return null;
}
