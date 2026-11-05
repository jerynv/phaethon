import { Component, Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DelimitedPreview, FilePreviewStatus, FilePreviewToolbar, ImagePreview, TextPreview } from "vic-ui";

import { RichMarkdown } from "@/components/assistant-ui/elements/markdown-text";
import { SyntaxHighlighter } from "@/components/assistant-ui/elements/syntax-highlighter";
import { SpaceIdContext } from "@/components/chat/approval-card";
import { revealLabel } from "@/components/chat/receipts";
import { PdfView } from "@/components/rich/pdf-view";
import { ShowSource, SourceBlock } from "@/components/rich/source";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/icons";
import { fileBytes, fileView, imageType, isByteKind, kindOfFile, previewByteLimit, type FileView, type ViewKind } from "@/lib/files";
import { latexCompile, latexPdf, latexSave, type LatexOutcome } from "@/lib/latex";
import { cn } from "@/lib/utils";
import { formatBytes, typeLabel } from "@/runtime/attachments";
import { openSpaceFile } from "@/runtime/records";

/** What the viewer shows. */
export type ViewSource =
  /** A file in a space, or a course the space may see (read through the core's walls). */
  | { kind: "space"; space: string; path: string; anchor?: string; headingIndex?: number; page?: number; textPath?: string }
  /** Bytes already here: a file being attached, or one just sent. */
  | { kind: "bytes"; name: string; mediaType?: string; size?: number; load: () => Promise<ArrayBuffer> }
  /** A LaTeX document (or figure) from a reply, compiled to a PDF. `space` lets it be saved. */
  | { kind: "latex"; title: string; source: string; figure?: boolean; space?: string };

/** The folder a viewed file is in, so the relative links in a Markdown file lead beside it. */
export const LinkBaseContext = createContext("");

const dirOf = (path: string) => path.split("/").slice(0, -1).join("/");
const nameOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "file"; view: FileView; bytes: ArrayBuffer | null }
  | { state: "latex"; outcome: LatexOutcome; pdf: ArrayBuffer | null; text: string };

/** Read what `source` names: text inline, a PDF's or a picture's bytes, a document compiled. */
function useLoaded(source: ViewSource, compileTex: boolean, attempt: number): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  useEffect(() => {
    let stale = false;
    setLoaded({ state: "loading" });
    const done = (l: Loaded) => !stale && setLoaded(l);
    void (async () => {
      try {
        if (source.kind === "latex" || (compileTex && source.kind !== "bytes")) {
          const text = source.kind === "latex" ? source.source : ((await fileView(source.space, source.path)).text ?? "");
          const outcome = await latexCompile(text, source.kind === "latex" && !!source.figure);
          done({ state: "latex", outcome, pdf: outcome.status === "ok" ? await latexPdf(outcome.id) : null, text });
          return;
        }
        if (source.kind === "space") {
          const view = await fileView(source.space, source.path);
          if (isByteKind(view.kind) && view.size > previewByteLimit(view.kind)) view.tooBig = true;
          const wantsBytes = isByteKind(view.kind) && !view.tooBig;
          done({ state: "file", view, bytes: wantsBytes ? await fileBytes(source.space, source.path) : null });
          return;
        }
        const kind: ViewKind = kindOfFile(source.name, source.mediaType);
        if (source.size != null && isByteKind(kind) && source.size > previewByteLimit(kind)) {
          done({ state: "file", view: { path: source.name, name: source.name, kind, size: source.size, mediaType: source.mediaType ?? "", text: null, language: null, tooBig: true }, bytes: null });
          return;
        }
        const bytes = await source.load();
        const big = isByteKind(kind) ? bytes.byteLength > previewByteLimit(kind) : (kind === "text" || kind === "markdown" || kind === "tex") && bytes.byteLength > 1024 * 1024;
        const text = (kind === "text" || kind === "markdown" || kind === "tex") && !big ? new TextDecoder().decode(bytes) : null;
        done({
          state: "file",
          view: { path: source.name, name: source.name, kind, size: bytes.byteLength, mediaType: source.mediaType ?? "", text, language: null, tooBig: big },
          bytes: isByteKind(kind) && !big ? bytes : null,
        });
      } catch (e) {
        done({ state: "error", message: String(e instanceof Error ? e.message : e) });
      }
    })();
    return () => {
      stale = true;
    };
  }, [source, compileTex, attempt]);
  return loaded;
}

/** Plain code with syntax colours where the language is known. */
function CodeView({ text, language, label }: { text: string; language: string | null; label: string }) {
  const components = useMemo(
    () => ({
      Pre: ({ className, ...p }: React.ComponentProps<"pre">) => (
        <pre
          {...p}
          tabIndex={0}
          aria-label={label}
          className={cn("min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-surface-sunken p-3 font-mono text-sm leading-normal", className)}
        />
      ),
      Code: (p: React.ComponentProps<"code">) => <code {...p} />,
    }),
    [label],
  );
  return <SyntaxHighlighter language={language ?? "text"} code={text} components={components} />;
}

/** Ready, permission-checked inputs; Vic owns rendering and its object URLs. */
function ImageView({ bytes, name, mediaType }: { bytes: ArrayBuffer; name: string; mediaType: string }) {
  const input = useMemo(() => new Uint8Array(bytes), [bytes]);
  return <ImagePreview input={input} alt={name} mimeType={imageType(name, mediaType)} className="min-h-0 flex-1" />;
}

class PreviewBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { message: string }> {
  state = { message: "" };
  static getDerivedStateFromError(error: unknown) { return { message: error instanceof Error ? error.message : String(error) }; }
  render() {
    return this.state.message ? <FilePreviewStatus status="error" title="Couldn’t load preview" message={this.state.message} onRetry={this.props.onRetry} /> : this.props.children;
  }
}

/** Optional modules are loaded only after the host has admitted and read these bytes. */
function OfficeMediaView({ view, bytes, onRetry }: { view: FileView; bytes: ArrayBuffer; onRetry: () => void }) {
  const input = useMemo(() => new Uint8Array(bytes), [bytes]);
  // A fresh mounted attempt also retries a rejected lazy chunk, preserving the rest of the app.
  const views = useMemo(() => ({
    Docx: lazy(() => import("vic-ui/preview/docx").then(module => ({ default: module.DocxPreview }))),
    Xlsx: lazy(() => import("vic-ui/preview/office").then(module => ({ default: module.XlsxPreview }))),
    Pptx: lazy(() => import("vic-ui/preview/office").then(module => ({ default: module.PptxPreview }))),
    Audio: lazy(() => import("vic-ui/preview/media").then(module => ({ default: module.AudioPreview }))),
    Video: lazy(() => import("vic-ui/preview/media").then(module => ({ default: module.VideoPreview }))),
  }), []);
  const props = { input, title: view.name, maxBytes: previewByteLimit(view.kind), className: "min-h-0 flex-1" };
  const mediaType = view.mediaType && view.mediaType !== "application/octet-stream" ? view.mediaType : undefined;
  return <PreviewBoundary onRetry={onRetry}><Suspense fallback={<FilePreviewStatus status="loading" title="Opening preview" />}>
    {view.kind === "docx" && <views.Docx {...props} />}
    {view.kind === "spreadsheet" && <views.Xlsx {...props} />}
    {view.kind === "slides" && <views.Pptx {...props} />}
    {view.kind === "audio" && <views.Audio {...props} mimeType={mediaType} />}
    {view.kind === "video" && <views.Video {...props} mimeType={mediaType} />}
  </Suspense></PreviewBoundary>;
}

function DataView({ view }: { view: FileView }) {
  const input = useMemo(() => new Blob([view.text ?? ""], { type: "text/plain" }), [view.text]);
  const extension = view.name.toLowerCase().split(".").pop();
  if (extension === "csv" || extension === "tsv") {
    return <DelimitedPreview input={input} name={view.name} delimiter={extension === "tsv" ? "\t" : ","} className="min-h-0 max-h-none flex-1" />;
  }
  return view.language
    ? <CodeView text={view.text ?? ""} language={view.language} label={view.name} />
    : <TextPreview input={input} name={view.name} className="min-h-0 max-h-none flex-1" />;
}

/** Why there's no PDF, with the log one fold below. */
function LatexProblem({ outcome, source }: { outcome: Exclude<LatexOutcome, { status: "ok" }>; source: string }) {
  return (
    <div className="flex flex-col gap-3" data-latex-problem={outcome.status}>
      <p role="alert" className="flex items-start gap-2 rounded-md border border-line bg-surface px-3 py-2 text-ink">
        <Icon name={outcome.status === "failed" ? "warning" : "info"} className="mt-0.5 shrink-0 text-ink-secondary" />
        <span>{outcome.message}</span>
      </p>
      {outcome.status === "failed" && outcome.log && (
        <Details summary="Show LaTeX’s log">
          <SourceBlock code={outcome.log} label="LaTeX’s log" />
        </Details>
      )}
      <ShowSource code={source} what="document" />
    </div>
  );
}

/** What the viewer shows for each kind of file. */
function Body({ source, loaded, base, onCompile, onRetry }: { source: ViewSource; loaded: Loaded; base: string; onCompile: () => void; onRetry: () => void }) {
  if (loaded.state === "loading") {
    return (
      <FilePreviewStatus status="loading" title={source.kind === "latex" ? "Making PDF" : "Opening file"} />
    );
  }
  if (loaded.state === "error") {
    return (
      <div data-viewer-error=""><FilePreviewStatus status="error" title="Couldn’t open file" message={loaded.message} onRetry={onRetry} /></div>
    );
  }
  if (loaded.state === "latex") {
    if (loaded.outcome.status !== "ok" || !loaded.pdf) {
      return loaded.outcome.status === "ok" ? null : <LatexProblem outcome={loaded.outcome} source={loaded.text} />;
    }
    return <PdfView data={loaded.pdf} label={source.kind === "latex" ? source.title : nameOf(source.kind === "space" ? source.path : source.name)} className="min-h-0 flex-1" />;
  }
  const { view, bytes } = loaded;
  if (view.tooBig) {
    return (
      <p className="text-ink">
        This file is {formatBytes(view.size)}, larger than Phaethon shows here. Open it in its app instead.
      </p>
    );
  }
  switch (view.kind) {
    case "pdf":
      return bytes ? <PdfView data={bytes} label={view.name} initialPage={source.kind === "space" ? source.page : undefined} className="min-h-0 flex-1" /> : null;
    case "image":
      return bytes ? <ImageView bytes={bytes} name={view.name} mediaType={view.mediaType} /> : null;
    case "docx":
    case "spreadsheet":
    case "slides":
    case "audio":
    case "video":
      return bytes ? <OfficeMediaView view={view} bytes={bytes} onRetry={onRetry} /> : null;
    case "markdown":
      return (
        <div tabIndex={0} role="region" aria-label={view.name} className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-bg px-5 py-4" data-viewer-markdown="">
          <SpaceIdContext.Provider value={source.kind === "space" ? source.space : ""}>
            <LinkBaseContext.Provider value={base}>
              <RichMarkdown text={view.text ?? ""} className="max-w-(--ph-measure)" />
            </LinkBaseContext.Provider>
          </SpaceIdContext.Provider>
        </div>
      );
    case "tex":
      return (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {source.kind === "space" && (
            <p className="flex flex-wrap items-center gap-2 text-ink-secondary">
              A LaTeX document.
              <Button type="button" variant="outline" size="sm" onClick={onCompile} data-viewer-compile="">
                <Icon name="file-text" />
                View the PDF
              </Button>
            </p>
          )}
          <CodeView text={view.text ?? ""} language={null} label={`${view.name}, its source`} />
        </div>
      );
    case "text":
      return <DataView view={view} />;
    case "other":
      return (
        <p className="text-ink" data-viewer-other="">
          Phaethon can’t show this kind of file{view.mediaType && view.mediaType !== "application/octet-stream" ? ` (${view.mediaType})` : ""} here.
          {source.kind === "space" ? " Open it in its app, or show it in Finder." : ""}
        </p>
      );
  }
}

/** "PDF · 146 KB · notes/week6.pdf": what the file is, for the dialog's description. */
function describe(source: ViewSource, loaded: Loaded): string {
  if (loaded.state === "latex") {
    const what = source.kind === "latex" && source.figure ? "LaTeX figure" : "LaTeX document";
    const where = source.kind === "space" ? ` · ${source.path}` : "";
    return loaded.outcome.status === "ok" ? `${what} as a PDF, made with ${loaded.outcome.engine}${where}` : `${what}${where}`;
  }
  if (source.kind === "latex") return source.figure ? "LaTeX figure" : "LaTeX document";
  const name = source.kind === "space" ? source.path : source.name;
  if (loaded.state !== "file") return name;
  const v = loaded.view;
  const what = v.kind === "tex" ? "LaTeX" : v.kind === "text" && v.language ? v.language[0].toUpperCase() + v.language.slice(1) : typeLabel(v.name, v.mediaType);
  return [what, formatBytes(v.size), source.kind === "space" ? source.path : null].filter(Boolean).join(" · ");
}

/** Open in its app and Show in Finder, for a file in the space; Save to space for a document. */
function Actions({ source, loaded }: { source: ViewSource; loaded: Loaded }) {
  const [said, setSaid] = useState<{ text: string; problem: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  if (source.kind === "bytes") return null;
  if (source.kind === "latex") {
    if (!source.space) return null;
    const space = source.space;
    return (
      <div className="flex flex-wrap items-center justify-end gap-2">
        {said && (
          <p role={said.problem ? "alert" : "status"} className={cn("me-auto text-sm", said.problem ? "text-danger-ink" : "text-ink-secondary")} data-viewer-said="">
            {said.text}
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          data-viewer-save=""
          onClick={async () => {
            setSaving(true);
            try {
              const s = await latexSave(space, source.source, source.title, !!source.figure);
              setSaid({ text: s.pdf ? `Saved ${s.tex} and ${s.pdf}.` : `Saved ${s.tex}.${s.note ? ` ${s.note}` : ""}`, problem: false });
            } catch (e) {
              setSaid({ text: `It couldn’t be saved: ${String(e)}`, problem: true });
            } finally {
              setSaving(false);
            }
          }}
        >
          <Icon name="download" />
          {saving ? "Saving…" : "Save to space"}
        </Button>
      </div>
    );
  }
  const open = async (reveal: boolean) => {
    setSaid(null);
    try {
      await openSpaceFile(source.space, source.path, reveal);
    } catch (e) {
      setSaid({ text: String(e), problem: true });
    }
  };
  const canOpen = loaded.state !== "error";
  return (
    <FilePreviewToolbar label="File actions" className="justify-end">
      {said && (
        <p role="alert" className="me-auto text-sm text-danger-ink">
          {said.text}
        </p>
      )}
      <Button type="button" variant="ghost" disabled={!canOpen} onClick={() => void open(true)} data-viewer-reveal="">
        <Icon name="folder" />
        {revealLabel()}
      </Button>
      <Button type="button" variant="outline" disabled={!canOpen} onClick={() => void open(false)} data-viewer-open-app="">
        Open in its app
      </Button>
    </FilePreviewToolbar>
  );
}

/**
 * A file shown inside Phaethon: Markdown with its math and diagrams, a PDF
 * with selectable text, a picture, code, a LaTeX document compiled to a
 * PDF; anything else is named, with its app one click away. A dialog: it
 * takes focus, Escape closes it, and focus goes back where it was.
 */
export function FileViewer({
  source,
  open,
  onOpenChange,
  returnTo,
}: {
  source: ViewSource | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes back to on close (the control that opened it), when it has no Radix trigger. */
  returnTo?: HTMLElement | null;
}) {
  return (
    <Dialog open={open && !!source} onOpenChange={onOpenChange}>
      {source && <ViewerContent source={source} returnTo={returnTo} />}
    </Dialog>
  );
}

function ViewerContent({ source, returnTo }: { source: ViewSource; returnTo?: HTMLElement | null }) {
  // A .tex file from the space can be compiled and shown as its PDF.
  const [compileTex, setCompileTex] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [textMode, setTextMode] = useState(false);
  const renderedSource = useMemo<ViewSource>(() => source.kind === "space" && source.textPath && textMode
    ? { kind: "space", space: source.space, path: source.textPath } : source, [source, textMode]);
  const loaded = useLoaded(renderedSource, compileTex, attempt);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (source.kind !== "space" || (!source.anchor && source.headingIndex === undefined) || loaded.state !== "file" || loaded.view.kind !== "markdown") return;
    const target = source.anchor;
    const frame = requestAnimationFrame(() => {
      if (source.headingIndex !== undefined) {
        const heading = contentRef.current?.querySelectorAll<HTMLElement>('[data-viewer-markdown] [data-md-depth="2"]')[source.headingIndex];
        if (heading) { heading.scrollIntoView({ block: "start", behavior: "instant" }); heading.tabIndex = -1; heading.focus({ preventScroll: true }); return; }
      }
      const used = new Map<string, number>();
      const headings = contentRef.current?.querySelectorAll<HTMLElement>("[data-viewer-markdown] :is(h1,h2,h3,h4,h5,h6)") ?? [];
      for (const heading of headings) {
        // Match the importer's Unicode heading anchors, including duplicate titles.
        const base = (heading.textContent ?? "").toLowerCase().replaceAll(" ", "-").replace(/[^\p{L}\p{N}_-]/gu, "");
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        if ((n ? `${base}-${n}` : base) !== target && heading.id !== target) continue;
        heading.scrollIntoView({ block: "start", behavior: "instant" });
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
        break;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [loaded, source]);
  const title = source.kind === "latex" ? source.title : source.kind === "space" ? nameOf(source.path) : source.name;
  const base = source.kind === "space" ? dirOf(source.path) : "";
  return (
    <DialogContent
      ref={contentRef}
      className="flex h-[calc(100dvh-var(--ph-space)*8)] max-w-(--ph-viewer-width) flex-col gap-3 overflow-hidden"
      data-file-viewer={source.kind === "space" ? source.path : source.kind}
      onCloseAutoFocus={(e) => {
        if (returnTo?.isConnected) {
          e.preventDefault();
          returnTo.focus();
        }
      }}
    >
      <DialogHeader>
        <DialogTitle className="wrap-anywhere">{title}</DialogTitle>
        <DialogDescription className="text-sm wrap-anywhere">{describe(renderedSource, loaded)}</DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col" data-viewer-body="">
        <Body source={renderedSource} loaded={loaded} base={textMode && source.kind === "space" && source.textPath ? dirOf(source.textPath) : base} onCompile={() => setCompileTex(true)} onRetry={() => setAttempt((n) => n + 1)} />
      </div>
      {source.kind === "space" && source.textPath && <div className="flex items-center gap-1" role="group" aria-label="Preview format" data-preview-format="">
        <Button type="button" variant="ghost" size="sm" aria-pressed={!textMode} onClick={() => setTextMode(false)}>Document</Button>
        <Button type="button" variant="ghost" size="sm" aria-pressed={textMode} data-preview-text="" onClick={() => setTextMode(true)}>Extracted text</Button>
      </div>}
      <Actions source={source} loaded={loaded} />
    </DialogContent>
  );
}

/** One viewer per place that opens files: `open(source)` shows it; `viewer` goes in the tree. */
export function useFileViewer(): { open: (source: ViewSource) => void; viewer: ReactNode } {
  const [source, setSource] = useState<ViewSource | null>(null);
  const [isOpen, setOpen] = useState(false);
  const [returnTo, setReturnTo] = useState<HTMLElement | null>(null);
  const open = useCallback((s: ViewSource) => {
    setReturnTo(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setSource(s);
    setOpen(true);
  }, []);
  const viewer = <FileViewer source={source} open={isOpen} onOpenChange={setOpen} returnTo={returnTo} />;
  return { open, viewer };
}

/**
 * A path in the space as a link that opens it in the viewer (a link in a
 * reply, a file Phaethon wrote). `children` is what it says; by default the path.
 */
export function SpaceFileLink({
  space,
  path,
  page,
  children,
  className,
  ...rest
}: { space: string; path: string; page?: number; children?: ReactNode; className?: string } & Omit<React.ComponentProps<"button">, "onClick" | "type">) {
  const { open, viewer } = useFileViewer();
  return (
    <>
      <button
        type="button"
        className={cn("cursor-pointer text-start text-accent-ink underline decoration-1 underline-offset-2 hover:decoration-2", className)}
        onClick={() => open({ kind: "space", space, path, page })}
        data-view-file={path}
        {...rest}
      >
        {children ?? path}
      </button>
      {viewer}
    </>
  );
}

/** The folder links are relative to where markdown is shown ("" in a reply). */
export const useLinkBase = () => useContext(LinkBaseContext);
