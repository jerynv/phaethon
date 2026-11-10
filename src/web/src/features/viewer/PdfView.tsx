// pdf.js (Apache-2.0, Mozilla), loaded only when a PDF is first shown. Its
// worker is a file of the app's own bundle; no fetches (the bytes come over
// the core's wire), no XFA, no scripts.
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
import { MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

GlobalWorkerOptions.workerPort ??= new PdfWorker();

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

function Page({ doc, n, scale, width }: { doc: PDFDocumentProxy; n: number; scale: number; width: number }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [seen, setSeen] = useState(n <= 2);

  useEffect(() => {
    const el = box.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  useEffect(() => {
    let live = true;
    let task: { cancel(): void } | null = null;
    void doc.getPage(n).then(async (page) => {
      const base = page.getViewport({ scale: 1 });
      const fit = (width / base.width) * scale;
      const viewport = page.getViewport({ scale: fit });
      if (!live) return;
      setSize({ w: viewport.width, h: viewport.height });
      if (!seen || !canvas.current) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 3);
      const c = canvas.current;
      c.width = Math.floor(viewport.width * ratio);
      c.height = Math.floor(viewport.height * ratio);
      const render = page.render({ canvas: c, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      task = render;
      await render.promise.catch(() => {});
      if (!live || !text.current) return;
      text.current.replaceChildren();
      text.current.style.setProperty("--scale-factor", String(fit));
      text.current.style.setProperty("--total-scale-factor", String(fit));
      text.current.style.setProperty("--user-unit", "1");
      text.current.style.setProperty("--scale-round-x", "1px");
      text.current.style.setProperty("--scale-round-y", "1px");
      await new TextLayer({ textContentSource: page.streamTextContent(), container: text.current, viewport }).render().catch(() => {});
    });
    return () => {
      live = false;
      task?.cancel();
    };
  }, [doc, n, scale, width, seen]);

  return (
    <div
      ref={box}
      role="group"
      aria-label={`Page ${n}`}
      data-page={n}
      className="relative mx-auto bg-white shadow-sm ring-1 ring-black/10"
      style={{ width: size?.w ?? width * scale, height: size?.h ?? width * scale * 1.3 }}
    >
      <canvas ref={canvas} aria-hidden className="absolute inset-0 size-full" />
      <div ref={text} className="ph-pdf-text absolute inset-0 overflow-hidden leading-none" />
    </div>
  );
}

/**
 * A PDF in place: every page drawn as it scrolls near, with its text laid
 * over the picture (selectable, and read by screen readers), and zoom.
 */
export default function PdfView({ data, label, initialPage }: { data: ArrayBuffer; label: string; initialPage?: number }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(2);
  const [width, setWidth] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    let opened: PDFDocumentProxy | null = null;
    getDocument({ data: new Uint8Array(data.slice(0)), enableXfa: false, useWorkerFetch: false, disableAutoFetch: true, stopAtErrors: false })
      .promise.then(
        (d) => {
          opened = d;
          if (live) setDoc(d);
        },
        (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      live = false;
      void opened?.loadingTask.destroy();
    };
  }, [data]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setWidth(Math.min(el.clientWidth - 32, 900));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || !initialPage) return;
    requestAnimationFrame(() => scroller.current?.querySelector(`[data-page="${initialPage}"]`)?.scrollIntoView());
  }, [doc, initialPage]);

  if (error) return <p className="p-6 text-sm">This PDF couldn’t be read: {error}</p>;
  const scale = ZOOMS[zoom];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-sm text-muted-foreground">
        <span>{doc ? `${doc.numPages} ${doc.numPages === 1 ? "page" : "pages"}` : "Opening…"}</span>
        <div role="group" aria-label="Zoom" className="flex items-center gap-1">
          <Button variant="ghost-muted" size="icon-xs" aria-label="Zoom out" disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>
            <MinusIcon aria-hidden className="size-3.5" />
          </Button>
          <span className="w-12 text-center tabular-nums" aria-live="polite">
            {Math.round(scale * 100)}%
          </span>
          <Button variant="ghost-muted" size="icon-xs" aria-label="Zoom in" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}>
            <PlusIcon aria-hidden className="size-3.5" />
          </Button>
        </div>
      </div>
      <div ref={scroller} tabIndex={0} role="document" aria-label={label} className="min-h-0 flex-1 overflow-auto bg-muted/60 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        {doc && width > 0 && (
          <div className="flex flex-col gap-4 px-4">
            {Array.from({ length: doc.numPages }, (_, i) => (
              <Page key={i + 1} doc={doc} n={i + 1} scale={scale} width={width} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
