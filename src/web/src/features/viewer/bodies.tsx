import type { PDFDocumentProxy } from "pdfjs-dist";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/features/courses/lib/sites";
import { CodeBlock } from "@/features/chat/components/CodeBlock";
import { Markdown } from "@/features/chat/components/Markdown";
import { observeResize } from "@/lib/observe-resize";
import { openPdf, renderPage } from "@/lib/pdf";
import { cn } from "@/lib/utils";
import { FileIcon } from "./FileIcon";
import { type FileView, imageType, languageOf, type ViewKind } from "./kinds";

const PAD = 16;

/** Stands in for a file while it loads: a page for documents, lines for text. */
export function PageSkeleton({ kind }: { kind: ViewKind }) {
  const paper = ["pdf", "docx", "image", "slides"].includes(kind);
  const lines = ["92%", "86%", "64%", "0", "90%", "78%", "88%", "52%", "0", "84%", "70%"];
  return (
    <div className="p-4 motion-safe:animate-skeleton" aria-hidden>
      {paper ? (
        <div className="flex aspect-[1/1.294] w-full flex-col gap-2.5 rounded-sm border bg-card p-[9%] shadow-xs/5">
          <Skeleton className="mb-3 h-3 w-1/2 animate-none" />
          {lines.map((w, i) => (w === "0" ? <div key={i} className="h-2" /> : <Skeleton key={i} className="h-2 animate-none" style={{ width: w }} />))}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 pt-1">
          <Skeleton className="mb-2 h-3.5 w-2/5 animate-none" />
          {lines.map((w, i) => (w === "0" ? <div key={i} className="h-1.5" /> : <Skeleton key={i} className="h-2.5 animate-none" style={{ width: w }} />))}
        </div>
      )}
    </div>
  );
}

/** A file the viewer won't show in place, with a way to open it. */
function Placeholder({ view, title, text, onOpen }: { view: FileView; title: string; text?: string; onOpen: () => void }) {
  return (
    <div className="flex flex-col items-center px-6 pt-16 pb-8 text-center">
      <div className="mb-4 flex size-10 items-center justify-center rounded-lg border bg-card shadow-xs/5">
        <FileIcon kind={view.kind} name={view.name} className="size-5" />
      </div>
      <p className="font-medium text-sm">{title}</p>
      {text ? <p className="mt-1 max-w-64 text-balance text-muted-foreground text-xs tabular-nums">{text}</p> : null}
      <Button size="sm" variant="outline" className="mt-4" onClick={onOpen}>
        <ExternalLinkIcon />
        Open in default app
      </Button>
    </div>
  );
}

export function Body({
  space,
  view,
  bytes,
  preview,
  onOpen,
  onMeta,
}: {
  space: string;
  view: FileView;
  bytes?: ArrayBuffer;
  preview: "show" | "tooBig" | "unsupported";
  onOpen: () => void;
  onMeta: (m: string | null) => void;
}) {
  if (preview === "tooBig") return <Placeholder view={view} title="Too big to preview" text={`This file is ${formatBytes(view.size)}.`} onOpen={onOpen} />;
  if (preview === "unsupported") return <Placeholder view={view} title="No preview for this kind of file" onOpen={onOpen} />;
  switch (view.kind) {
    case "markdown":
      return (
        <div className="px-5 py-4 text-base">
          <Markdown text={view.text ?? ""} space={space} messageKey={`viewer:${view.path}`} />
        </div>
      );
    case "text":
    case "tex":
      return (
        <div className="p-3 [&_.md-code]:my-0">
          <CodeBlock code={view.text ?? ""} lang={view.kind === "tex" ? "latex" : (view.language ?? languageOf(view.name))} />
        </div>
      );
    case "pdf":
      return bytes ? <PdfBody bytes={bytes} onMeta={onMeta} /> : null;
    case "image":
      return bytes ? <ImageBody bytes={bytes} view={view} /> : null;
    case "docx":
      return bytes ? <DocxBody bytes={bytes} onOpen={onOpen} /> : null;
    case "audio":
    case "video":
      return bytes ? <MediaBody bytes={bytes} view={view} /> : null;
    default:
      return <Placeholder view={view} title="No preview for this kind of file" onOpen={onOpen} />;
  }
}

function useObjectUrl(bytes: ArrayBuffer, type: string) {
  const url = useMemo(() => URL.createObjectURL(new Blob([bytes], { type })), [bytes, type]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return url;
}

function ImageBody({ bytes, view }: { bytes: ArrayBuffer; view: FileView }) {
  const url = useObjectUrl(bytes, imageType(view.name, view.mediaType));
  const [broken, setBroken] = useState(false);
  if (broken) return <div className="p-3"><SurfaceError title="Couldn’t show this picture" message="The file may be damaged, or in a format this window can’t draw." /></div>;
  return (
    <div className="flex min-h-full items-start justify-center p-4">
      <img src={url} alt={view.name} onError={() => setBroken(true)} className="max-w-full rounded-sm border bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px] object-contain" />
    </div>
  );
}

function MediaBody({ bytes, view }: { bytes: ArrayBuffer; view: FileView }) {
  const url = useObjectUrl(bytes, view.mediaType || (view.kind === "audio" ? "audio/mpeg" : "video/mp4"));
  return (
    <div className="p-4">
      {view.kind === "audio" ? <audio src={url} controls className="w-full" /> : <video src={url} controls className="w-full rounded-sm border bg-black" />}
    </div>
  );
}

/** The panel's inner width, kept current. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    setWidth(el.clientWidth);
    const stop = observeResize(el, () => {
      clearTimeout(t);
      t = setTimeout(() => setWidth(el.clientWidth), 120);
    });
    return () => {
      clearTimeout(t);
      stop();
    };
  }, []);
  return [ref, width] as const;
}

function PdfBody({ bytes, onMeta }: { bytes: ArrayBuffer; onMeta: (m: string | null) => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [ratio, setRatio] = useState(1.294);
  const [error, setError] = useState<string | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>();

  useEffect(() => {
    let live = true;
    let opened: PDFDocumentProxy | null = null;
    // pdf.js takes the buffer over, so it gets a copy.
    openPdf(bytes.slice(0))
      .then(async (d) => {
        opened = d;
        const first = await d.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (!live) return;
        setRatio(vp.height / vp.width);
        setDoc(d);
        onMeta(d.numPages === 1 ? "1 page" : `${d.numPages} pages`);
      })
      .catch((e) => live && setError(cleanMessage(e)));
    return () => {
      live = false;
      void opened?.loadingTask.destroy();
    };
  }, [bytes, onMeta]);

  const pageWidth = Math.max(0, width - PAD * 2);
  if (error) return <div className="p-3"><SurfaceError title="Couldn’t read this PDF" message={error} /></div>;
  return (
    <div ref={ref} className="flex flex-col gap-3 p-4">
      {!doc || !pageWidth ? (
        <div className="aspect-[1/1.294] w-full rounded-sm border bg-white" />
      ) : (
        Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i} doc={doc} n={i + 1} width={pageWidth} ratio={ratio} />)
      )}
    </div>
  );
}

/** One page, drawn when it comes near the visible area and again when the width changes. */
function PdfPage({ doc, n, width, ratio }: { doc: PDFDocumentProxy; n: number; width: number; ratio: number }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(n <= 2);
  const [drawn, setDrawn] = useState(0);
  const [failed, setFailed] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    const el = box.current;
    if (!el || near) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near || !canvas.current || drawn === width) return;
    let live = true;
    const el = canvas.current;
    // pdf.js refuses a second render on a canvas while one runs, so renders queue.
    queue.current = queue.current.then(() =>
      live
        ? renderPage(doc, n, el, width).then(
            () => live && setDrawn(width),
            () => live && setFailed(true),
          )
        : undefined,
    );
    return () => {
      live = false;
    };
  }, [near, doc, n, width, drawn]);

  return (
    <div ref={box} className="relative overflow-hidden rounded-sm border bg-white shadow-xs/5" style={{ width, minHeight: drawn ? undefined : Math.round(width * ratio) }}>
      <canvas ref={canvas} className={cn("block", !drawn && "invisible absolute")} />
      {failed ? <p className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500">Page {n} couldn’t be drawn.</p> : null}
      <span className="pointer-events-none absolute right-1.5 bottom-1 rounded bg-black/55 px-1 text-3xs text-white tabular-nums">{n}</span>
    </div>
  );
}

function DocxBody({ bytes, onOpen }: { bytes: ArrayBuffer; onOpen: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "failed">("loading");
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let live = true;
    el.replaceChildren();
    import("docx-preview")
      .then((m) => m.renderAsync(bytes.slice(0), el, undefined, { inWrapper: false, ignoreWidth: true, ignoreHeight: true, breakPages: false, className: "docx", renderHeaders: false, renderFooters: false }))
      .then(
        () => live && setState("ok"),
        () => live && setState("failed"),
      );
    return () => {
      live = false;
    };
  }, [bytes]);
  return (
    <div className="p-4">
      {state === "failed" ? (
        <SurfaceError title="Couldn’t read this document" message="Open it in its own app instead." actions={[{ label: "Open in default app", onClick: onOpen }]} />
      ) : null}
      <div className={cn("overflow-x-auto rounded-sm border bg-white px-6 py-5 text-zinc-900 shadow-xs/5 [&_section.docx]:!p-0 [&_section.docx]:!w-auto [&_section.docx]:!min-h-0", state !== "ok" && "hidden")} ref={host} />
      {state === "loading" ? <PageSkeleton kind="docx" /> : null}
    </div>
  );
}
