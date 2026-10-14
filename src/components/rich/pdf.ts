// pdf.js (Apache-2.0, Mozilla), loaded only when a PDF or a compiled figure is
// first shown. Its worker is a file of the app's own bundle ('self' under the
// CSP); no fetches (the bytes come over IPC), no XFA, no scripts.
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";

// One worker for the session, bundled by Vite as a .js file of the app ('self').
GlobalWorkerOptions.workerPort = new PdfWorker();

export type { PDFDocumentProxy, PDFPageProxy };

/** Open a PDF from its bytes (copied: pdf.js hands the buffer to its worker). */
export function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  return getDocument({
    data: new Uint8Array(data.slice(0)),
    enableXfa: false,
    useWorkerFetch: false,
    disableAutoFetch: true,
    stopAtErrors: false,
  }).promise;
}

/**
 * Draw `page` at `scale` (CSS pixels per PDF point) into `canvas`, sharp on
 * this screen, and lay its text over it in `textBox` (selectable, read by
 * screen readers). Returns the page's size in CSS pixels.
 */
export async function drawPage(
  page: PDFPageProxy,
  scale: number,
  canvas: HTMLCanvasElement,
  textBox: HTMLElement | null,
): Promise<{ width: number; height: number }> {
  const viewport = page.getViewport({ scale });
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  await page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
  if (textBox) {
    textBox.replaceChildren();
    textBox.style.setProperty("--scale-factor", String(scale));
    textBox.style.setProperty("--total-scale-factor", String(scale));
    textBox.style.setProperty("--user-unit", "1");
    textBox.style.setProperty("--scale-round-x", "1px");
    textBox.style.setProperty("--scale-round-y", "1px");
    await new TextLayer({ textContentSource: page.streamTextContent(), container: textBox, viewport }).render();
  }
  return { width: viewport.width, height: viewport.height };
}

/** A page's text, in reading order as pdf.js has it: a figure's labels, for its description. */
export async function pageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  return content.items
    .map((i) => ("str" in i ? i.str : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A one-page PDF (a compiled figure) as a picture: a PNG data: address at
 * twice its size, its size in CSS pixels, and the text in it.
 */
export async function figurePicture(data: ArrayBuffer): Promise<{ src: string; width: number; height: number; text: string }> {
  const doc = await openPdf(data);
  try {
    const page = await doc.getPage(1);
    const canvas = document.createElement("canvas");
    const viewport = page.getViewport({ scale: 1.5 });
    canvas.width = Math.ceil(viewport.width * 2);
    canvas.height = Math.ceil(viewport.height * 2);
    await page.render({ canvas, viewport, transform: [2, 0, 0, 2, 0, 0] }).promise;
    return { src: canvas.toDataURL("image/png"), width: viewport.width, height: viewport.height, text: await pageText(page) };
  } finally {
    void doc.loadingTask.destroy();
  }
}
