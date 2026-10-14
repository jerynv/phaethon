import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";

import type { PDFDocumentProxy } from "./pdf";

const loadPdfJs = () => import("./pdf");

/** Zoom steps, as a share of the width that fits. */
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** Pages laid out at once; a longer PDF shows more on request. */
const PAGE_BATCH = 40;

type Size = { width: number; height: number };

/**
 * One page: its drawing and its text, drawn when it comes near the visible
 * part of the viewer (and again when the zoom changes). Read as "Page 2 of 3".
 */
function Page({ doc, n, total, scale, size }: { doc: PDFDocumentProxy; n: number; total: number; scale: number; size: Size }) {
  const box = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(n <= 2);
  const [failed, setFailed] = useState(false);
  // Its own size once known (a PDF's pages needn't all be the size of the first).
  const [own, setOwn] = useState<Size | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el || near) return;
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "800px 0px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let stale = false;
    void (async () => {
      try {
        const { drawPage } = await loadPdfJs();
        const page = await doc.getPage(n);
        const v = page.getViewport({ scale: 1 });
        if (stale || !canvas.current) return;
        if (v.width !== size.width || v.height !== size.height) setOwn({ width: v.width, height: v.height });
        await drawPage(page, scale, canvas.current, text.current);
      } catch {
        if (!stale) setFailed(true);
      }
    })();
    return () => {
      stale = true;
    };
  }, [doc, n, scale, near, size]);

  return (
    <section
      ref={box}
      aria-label={`Page ${n} of ${total}`}
      data-pdf-page={n}
      className="shrink-0"
      style={{ width: (own ?? size).width * scale, height: (own ?? size).height * scale }}
    >
      <canvas ref={canvas} aria-hidden="true" />
      <div ref={text} className="textLayer" />
      {failed && (
        <p role="alert" className="absolute inset-x-0 top-4 text-center text-sm text-danger-ink">
          Page {n} couldn’t be drawn.
        </p>
      )}
    </section>
  );
}

/**
 * A PDF shown in the app with pdf.js: every page drawn as it scrolls into
 * view, with its text laid over it, so the text can be selected, searched
 * with the find bar and read by a screen reader. Zoom out, zoom in and fit
 * width are buttons (also -, + and 0 while the pages have focus); the pages
 * scroll with the arrow keys, Page Up and Page Down.
 */
export function PdfView({ data, label, className }: { data: ArrayBuffer; label: string; className?: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [first, setFirst] = useState<Size | null>(null);
  const [problem, setProblem] = useState("");
  const [zoom, setZoom] = useState(1);
  const [shown, setShown] = useState(PAGE_BATCH);
  const [width, setWidth] = useState(0);
  const pages = useRef<HTMLDivElement>(null);
  const statusId = useId();

  useEffect(() => {
    let stale = false;
    let opened: PDFDocumentProxy | null = null;
    setDoc(null);
    setProblem("");
    void (async () => {
      try {
        const { openPdf } = await loadPdfJs();
        opened = await openPdf(data);
        const page = await opened.getPage(1);
        const v = page.getViewport({ scale: 1 });
        if (stale) return;
        setFirst({ width: v.width, height: v.height });
        setDoc(opened);
      } catch (e) {
        if (!stale) setProblem(`This PDF couldn’t be opened: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      stale = true;
      void opened?.loadingTask.destroy();
    };
  }, [data]);

  // The width the pages fit, less room for the scroll bar.
  useLayoutEffect(() => {
    const el = pages.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [doc]);

  const step = useCallback((dir: 1 | -1 | 0) => {
    setZoom((z) => {
      if (dir === 0) return 1;
      const i = ZOOMS.findIndex((v) => v >= z - 0.001);
      return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i === -1 ? ZOOMS.length - 1 : i) + dir))];
    });
  }, []);

  if (problem) {
    return (
      <p role="alert" className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-danger-ink">
        {problem}
      </p>
    );
  }
  const total = doc?.numPages ?? 0;
  const fit = first && width ? Math.max(0.2, (width - 32) / first.width) : 1;
  const scale = fit * zoom;
  const percent = Math.round(zoom * 100);
  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)} data-pdf-view="">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p id={statusId} role="status" className="text-sm text-ink-secondary" data-pdf-pages={total || undefined}>
          {doc ? `${total} page${total === 1 ? "" : "s"}` : "Opening the PDF…"}
        </p>
        <span className="ms-auto flex items-center gap-1" role="group" aria-label="Zoom">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom out" title="Zoom out (−)" disabled={!doc || zoom <= ZOOMS[0]} onClick={() => step(-1)} data-pdf-zoom-out="">
            <Icon name="remove" />
          </Button>
          <span className="min-w-[4ch] text-center text-sm tabular-nums text-ink-secondary" aria-live="polite" data-pdf-zoom={percent}>
            {percent}%
          </span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom in" title="Zoom in (+)" disabled={!doc || zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => step(1)} data-pdf-zoom-in="">
            <Icon name="plus" />
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={!doc || zoom === 1} onClick={() => step(0)}>
            Fit width
          </Button>
        </span>
      </div>
      <div
        ref={pages}
        // The pages scroll here, by keyboard too.
        tabIndex={0}
        role="region"
        aria-label={`${label}, ${total ? `${total} page${total === 1 ? "" : "s"}` : "opening"}`}
        aria-describedby={statusId}
        className="flex min-h-0 flex-1 flex-col items-center gap-4 overflow-auto rounded-lg border border-line bg-surface-sunken p-4"
        onKeyDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key === "+" || e.key === "=") step(1);
          else if (e.key === "-") step(-1);
          else if (e.key === "0") step(0);
          else return;
          e.preventDefault();
        }}
        data-pdf-pages-box=""
      >
        {doc &&
          first &&
          width > 0 &&
          Array.from({ length: Math.min(total, shown) }, (_, i) => (
            <Page key={i + 1} doc={doc} n={i + 1} total={total} scale={scale} size={first} />
          ))}
        {doc && total > shown && (
          <Button type="button" variant="outline" onClick={() => setShown((s) => s + PAGE_BATCH)}>
            Show {Math.min(PAGE_BATCH, total - shown)} more pages
          </Button>
        )}
      </div>
    </div>
  );
}
