import type { PDFDocumentProxy } from "pdfjs-dist";

/** pdf.js, loaded on first use with its worker bundled by Vite. */
let lib: Promise<typeof import("pdfjs-dist")> | null = null;

async function pdfjs() {
  lib ??= Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]).then(([m, w]) => {
    m.GlobalWorkerOptions.workerSrc = w.default;
    return m;
  });
  return lib;
}

export async function openPdf(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  const m = await pdfjs();
  return m.getDocument({ data: new Uint8Array(bytes) }).promise;
}

/** Draws one page into `canvas` at `width` CSS pixels, sharp on high-DPI screens. */
export async function renderPage(doc: PDFDocumentProxy, n: number, canvas: HTMLCanvasElement, width: number): Promise<void> {
  const page = await doc.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = width / base.width;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: scale * dpr });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
  canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
  await page.render({ canvas, viewport: vp }).promise;
}
