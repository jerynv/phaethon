import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { FilePreviewToolbar, Input as VicInput } from "vic-ui";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";

import type { PDFDocumentProxy } from "./pdf";

const loadPdfJs = () => import("./pdf");

/** Zoom steps, as a share of the width that fits. */
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** Pages laid out at once; a longer PDF shows more on request. */
const PAGE_BATCH = 40;
const SEARCH_PAGES = 1000;
const SEARCH_CHARS = 2_000_000;
const PAGE_TEXT_CHARS = 200_000;
type SearchResult = { state: "idle" | "searching" | "done" | "cancelled" | "error"; pages: number[]; scanned: number; partial: boolean; notice: string };
const emptySearch = (): SearchResult => ({ state: "idle", pages: [], scanned: 0, partial: false, notice: "" });
const windowFor = (n: number) => Math.floor((n - 1) / PAGE_BATCH) * PAGE_BATCH + 1;

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
  const drawing = useRef<Promise<unknown>>(Promise.resolve());
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
    const render = drawing.current.catch(() => {}).then(async () => {
      if (stale) return;
      try {
        const { drawPage } = await loadPdfJs();
        const page = await doc.getPage(n);
        const v = page.getViewport({ scale: 1 });
        if (stale || !canvas.current) return;
        setFailed(false);
        if (v.width !== size.width || v.height !== size.height) setOwn({ width: v.width, height: v.height });
        await drawPage(page, scale, canvas.current, text.current);
      } catch {
        if (!stale) setFailed(true);
      }
    });
    drawing.current = render;
    return () => { stale = true; };
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

/** Selectable PDF pages with a bounded layout, direct page navigation and
 * real matching-page search. Search does not claim occurrence highlighting.
 * The extraction/navigation pattern follows the verified V-Client source
 * pack (PdfView.tsx, 2f2713d8); Phaethon keeps loading and permission policy. */
export function PdfView({ data, label, initialPage = 1, className }: { data: ArrayBuffer; label: string; initialPage?: number; className?: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [first, setFirst] = useState<Size | null>(null);
  const [problem, setProblem] = useState("");
  const [zoom, setZoom] = useState(1);
  const [start, setStart] = useState(1);
  const [current, setCurrent] = useState(1);
  const [typed, setTyped] = useState<string | null>(null);
  const [pageError, setPageError] = useState("");
  const [width, setWidth] = useState(0);
  const [navigation, setNavigation] = useState(0);
  const [finding, setFinding] = useState(false);
  const [term, setTerm] = useState("");
  const [search, setSearch] = useState<SearchResult>(emptySearch);
  const [matchAt, setMatchAt] = useState(0);
  const pages = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const findButton = useRef<HTMLButtonElement>(null);
  const scrollTarget = useRef<{ n: number; focus: boolean } | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const generation = useRef(0);
  const cache = useRef<{ doc: PDFDocumentProxy; texts: Map<number, string>; chars: number; partial: Set<number> } | null>(null);
  const statusId = useId();

  const goTo = useCallback((requested: number, focus = false) => {
    if (!doc) return;
    const n = Math.max(1, Math.min(doc.numPages, Math.floor(requested)));
    scrollTarget.current = { n, focus };
    setStart(windowFor(n)); setCurrent(n); setTyped(null); setPageError("");
    setNavigation(value => value + 1);
  }, [doc]);
  const closeFind = useCallback(() => { generation.current += 1; setFinding(false); setTerm(""); setSearch(emptySearch()); findButton.current?.focus(); }, []);

  useLayoutEffect(() => {
    if (doc) goTo(Number.isFinite(initialPage) ? initialPage : 1, initialPage > 1);
  }, [doc, initialPage, goTo]);

  useLayoutEffect(() => {
    const target = scrollTarget.current;
    const region = pages.current;
    if (!doc || !width || !target || !region) return;
    const section = region.querySelector<HTMLElement>(`[data-pdf-page="${target.n}"]`);
    if (!section) return;
    // Layout offsets stay in scroll coordinates during the dialog's scale
    // transition; viewport rectangles would under-scroll a distant page.
    region.scrollTop = section.offsetTop - (Number.parseFloat(getComputedStyle(region).paddingTop) || 0);
    if (target.focus) region.focus({ preventScroll: true });
    scrollTarget.current = null;
  }, [doc, width, start, navigation, zoom]);

  useEffect(() => {
    let stale = false;
    let opened: PDFDocumentProxy | null = null;
    generation.current += 1;
    cache.current = null;
    setDoc(null); setFirst(null); setProblem(""); setZoom(1); setStart(1); setCurrent(1); setTyped(null);
    setFinding(false); setTerm(""); setSearch(emptySearch()); setPageError("");
    void (async () => {
      try {
        const { openPdf } = await loadPdfJs();
        opened = await openPdf(data);
        if (stale) { void opened.loadingTask.destroy(); return; }
        const page = await opened.getPage(1);
        const viewport = page.getViewport({ scale: 1 });
        if (stale) return;
        setFirst({ width: viewport.width, height: viewport.height });
        setDoc(opened);
      } catch (error) {
        if (!stale) setProblem(`This PDF couldn’t be opened: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => { stale = true; generation.current += 1; void opened?.loadingTask.destroy(); };
  }, [data]);

  useLayoutEffect(() => {
    const element = pages.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const watch = new ResizeObserver(measure); watch.observe(element);
    return () => watch.disconnect();
  }, [doc]);
  useEffect(() => () => { if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); }, []);
  useEffect(() => { if (finding) findInput.current?.focus(); }, [finding]);
  useEffect(() => {
    if (!finding) return;
    // Radix listens on document capture. Consume this local Escape before its
    // surrounding file dialog; a second Escape can then close that dialog.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(event.target instanceof Node) || !view.current?.contains(event.target)) return;
      event.preventDefault(); event.stopPropagation(); closeFind();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [finding, closeFind]);

  const step = useCallback((direction: 1 | -1 | 0) => {
    scrollTarget.current = { n: current, focus: false };
    setZoom(value => {
      if (direction === 0) return 1;
      const index = ZOOMS.findIndex(z => z >= value - 0.001);
      return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (index === -1 ? ZOOMS.length - 1 : index) + direction))];
    });
  }, [current]);

  useEffect(() => {
    const query = term.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    const version = ++generation.current;
    setMatchAt(0); setSearch(emptySearch());
    if (!doc || !finding || query.length < 2) return;
    if (cache.current?.doc !== doc) cache.current = { doc, texts: new Map(), chars: 0, partial: new Set() };
    const index = cache.current;
    const active = () => generation.current === version;
    setSearch({ ...emptySearch(), state: "searching" });
    const timer = window.setTimeout(() => {
      void (async () => {
        const found: number[] = [];
        let scanned = 0; let skipped = 0; let capped = false;
        for (let n = 1; n <= Math.min(doc.numPages, SEARCH_PAGES); n++) {
          if (!active()) return;
          let text = index.texts.get(n);
          if (text === undefined) {
            if (index.chars >= SEARCH_CHARS) { capped = true; break; }
            try {
              const page = await doc.getPage(n);
              const content = await page.getTextContent();
              if (!active()) return;
              const limit = Math.min(PAGE_TEXT_CHARS, SEARCH_CHARS - index.chars);
              const pieces: string[] = []; let length = 0;
              for (const item of content.items) {
                if (!("str" in item)) continue;
                const piece = item.str.slice(0, Math.max(0, limit - length));
                pieces.push(piece); length += piece.length + 1;
                if (piece.length !== item.str.length || length >= limit) { index.partial.add(n); break; }
              }
              const extracted = pieces.join(" ").replace(/\s+/g, " ").toLocaleLowerCase();
              if (extracted.length > limit) index.partial.add(n);
              text = extracted.slice(0, limit);
              index.texts.set(n, text); index.chars += text.length;
            } catch {
              if (!active()) return;
              skipped += 1; scanned = n; continue;
            }
          }
          scanned = n;
          if (text.includes(query)) found.push(n);
          capped ||= index.partial.has(n);
          if (n % 8 === 0) {
            if (!active()) return;
            setSearch({ state: "searching", pages: [...found], scanned, partial: false, notice: "" });
            await new Promise<void>(resolve => window.setTimeout(resolve, 0));
          }
        }
        if (!active()) return;
        const notices = [
          scanned < doc.numPages ? `Searched ${scanned} of ${doc.numPages} pages` : "",
          capped ? "Text limit reached" : "",
          skipped ? `${skipped} page${skipped === 1 ? "" : "s"} couldn’t be read` : "",
        ].filter(Boolean);
        setSearch({ state: skipped === scanned && skipped > 0 ? "error" : "done", pages: found, scanned, partial: notices.length > 0, notice: notices.join(" · ") });
        if (found[0] !== undefined) goTo(found[0]);
      })().catch(() => { if (active()) setSearch({ ...emptySearch(), state: "error", partial: true, notice: "PDF text could not be searched. Try again." }); });
    }, 180);
    return () => { window.clearTimeout(timer); if (generation.current === version) generation.current += 1; };
  }, [doc, finding, term, goTo]);

  const moveMatch = (direction: number) => {
    if (!search.pages.length) return;
    const next = (matchAt + direction + search.pages.length) % search.pages.length;
    setMatchAt(next); goTo(search.pages[next]);
  };
  const total = doc?.numPages ?? 0;
  const end = Math.min(total, start + PAGE_BATCH - 1);
  const fit = first && width ? Math.max(0.2, (width - 32) / first.width) : 1;
  const scale = fit * zoom;
  const percent = Math.round(zoom * 100);
  const searchLabel = search.state === "searching" ? `Searching ${search.scanned} of ${total} pages…`
    : search.state === "cancelled" ? `Search cancelled · ${search.pages.length} matching pages`
    : search.state === "error" ? "Text search unavailable"
    : search.state === "done" ? search.pages.length ? `Page ${search.pages[matchAt]} · ${matchAt + 1} of ${search.pages.length} matching pages` : search.partial ? "No matching pages in searched text" : "No matching pages"
    : "";
  if (problem) return <p role="alert" className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-danger-ink">{problem}</p>;

  return <div ref={view} className={cn("flex min-h-0 flex-col gap-2", className)} data-pdf-view="" onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && doc) { event.preventDefault(); event.stopPropagation(); setFinding(true); findInput.current?.focus(); }
  }}>
    <FilePreviewToolbar label="PDF navigation" className="flex-wrap gap-1!">
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Previous page" disabled={!doc || current <= 1} onClick={() => goTo(current - 1)} data-pdf-previous=""><Icon name="chevron-left" /></Button>
      <VicInput aria-label="PDF page" inputMode="numeric" placeholder="Page" value={doc ? typed ?? String(current) : ""} disabled={!doc}
        className="h-7! min-h-7! w-14! px-1! text-center text-xs! tabular-nums" data-pdf-page-input=""
        onChange={event => { setTyped(event.target.value.replace(/\D/g, "").slice(0, 6)); setPageError(""); }} onBlur={() => setTyped(null)} onKeyDown={event => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          const n = Number(typed ?? current);
          if (n >= 1 && n <= total) goTo(n, true);
          else setPageError(`Enter a page from 1 to ${total}.`);
        }} />
      <span id={statusId} className="text-xs tabular-nums text-ink-secondary" data-pdf-pages={total || undefined}>{doc ? `of ${total}` : "Opening PDF…"}</span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Next page" disabled={!doc || current >= total} onClick={() => goTo(current + 1)} data-pdf-next=""><Icon name="chevron-right" /></Button>
      <span className="ms-auto flex items-center gap-1" role="group" aria-label="Zoom">
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom out" title="Zoom out (−)" disabled={!doc || zoom <= ZOOMS[0]} onClick={() => step(-1)} data-pdf-zoom-out=""><Icon name="remove" /></Button>
        <span className="min-w-[4ch] text-center text-xs tabular-nums text-ink-secondary" aria-live="polite" data-pdf-zoom={percent}>{percent}%</span>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Zoom in" title="Zoom in (+)" disabled={!doc || zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => step(1)} data-pdf-zoom-in=""><Icon name="plus" /></Button>
        <Button type="button" variant="ghost" size="sm" disabled={!doc || zoom === 1} onClick={() => step(0)}>Fit width</Button>
      </span>
      <Button ref={findButton} type="button" variant="ghost" size="icon-sm" aria-label={finding ? "Close PDF find" : "Find in PDF"} aria-pressed={finding} disabled={!doc} onClick={() => finding ? closeFind() : setFinding(true)} data-pdf-find-toggle=""><Icon name="search" /></Button>
    </FilePreviewToolbar>
    {pageError && <p role="alert" className="text-xs text-danger-ink">{pageError}</p>}
    {finding && <FilePreviewToolbar label="PDF text search" className="flex-wrap gap-1!" data-pdf-find="">
      <VicInput ref={findInput} aria-label="Find in PDF" placeholder="Find words…" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={term} onChange={event => setTerm(event.target.value)}
        className="h-7! min-h-7! min-w-24! flex-1 px-2! text-xs!" data-pdf-find-input="" onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeFind(); }
          else if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1); }
        }} />
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Previous matching page" disabled={!search.pages.length} onClick={() => moveMatch(-1)} data-pdf-find-previous=""><Icon name="chevron-up" /></Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Next matching page" disabled={!search.pages.length} onClick={() => moveMatch(1)} data-pdf-find-next=""><Icon name="chevron-down" /></Button>
      {search.state === "searching" ? <Button type="button" variant="ghost" size="sm" onClick={() => { generation.current += 1; setSearch(value => ({ ...value, state: "cancelled", partial: true })); }} data-pdf-find-cancel="">Cancel</Button>
        : <Button type="button" variant="ghost" size="icon-sm" aria-label="Clear PDF find" disabled={!term} onClick={() => { setTerm(""); findInput.current?.focus(); }} data-pdf-find-clear=""><Icon name="close" /></Button>}
      <p role="status" className="basis-full text-xs text-ink-secondary" data-pdf-find-status={search.state}>{searchLabel}{search.notice && <span className="block" data-pdf-find-partial="">{search.notice}</span>}</p>
    </FilePreviewToolbar>}
    <div ref={pages} tabIndex={0} role="region" aria-label={`${label}, ${total ? `${total} page${total === 1 ? "" : "s"}` : "opening"}`} aria-describedby={statusId}
      className="relative flex min-h-0 flex-1 flex-col items-center gap-4 overflow-auto rounded-lg border border-line bg-surface-sunken p-4"
      onScroll={() => {
        if (scrollFrame.current !== null) return;
        scrollFrame.current = requestAnimationFrame(() => {
          scrollFrame.current = null;
          const region = pages.current; if (!region) return;
          const line = region.getBoundingClientRect().top + Math.min(100, region.clientHeight / 3);
          let reading = start;
          for (const section of region.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
            if (section.getBoundingClientRect().top <= line) reading = Number(section.dataset.pdfPage); else break;
          }
          setCurrent(reading);
        });
      }} onKeyDown={event => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "+" || event.key === "=") step(1);
        else if (event.key === "-") step(-1);
        else if (event.key === "0") step(0);
        else return;
        event.preventDefault();
      }} data-pdf-pages-box="" data-pdf-window-start={start}>
      {doc && start > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => goTo(Math.max(1, start - PAGE_BATCH))} data-pdf-previous-window="">Previous {Math.min(PAGE_BATCH, start - 1)} pages</Button>}
      {doc && first && width > 0 && Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => <Page key={start + offset} doc={doc} n={start + offset} total={total} scale={scale} size={first} />)}
      {doc && end < total && <Button type="button" variant="ghost" size="sm" onClick={() => goTo(end + 1)} data-pdf-next-window="">Next {Math.min(PAGE_BATCH, total - end)} pages</Button>}
    </div>
  </div>;
}
