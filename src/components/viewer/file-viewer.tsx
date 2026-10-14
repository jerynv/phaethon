import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

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
import { bytesToBase64, fileBytes, fileView, imageType, kindOfFile, type FileView, type ViewKind } from "@/lib/files";
import { latexCompile, latexPdf, latexSave, type LatexOutcome } from "@/lib/latex";
import { cn } from "@/lib/utils";
import { formatBytes, typeLabel } from "@/runtime/attachments";
import { openSpaceFile } from "@/runtime/records";

/** What the viewer shows. */
export type ViewSource =
  /** A file in a space, or a course the space may see (read through the core's walls). */
  | { kind: "space"; space: string; path: string }
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
function useLoaded(source: ViewSource, compileTex: boolean): Loaded {
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
          const wantsBytes = (view.kind === "pdf" || view.kind === "image") && !view.tooBig;
          done({ state: "file", view, bytes: wantsBytes ? await fileBytes(source.space, source.path) : null });
          return;
        }
        const bytes = await source.load();
        const kind: ViewKind = kindOfFile(source.name, source.mediaType);
        const big = (kind === "text" || kind === "markdown" || kind === "tex") && bytes.byteLength > 1024 * 1024;
        const text = (kind === "text" || kind === "markdown" || kind === "tex") && !big ? new TextDecoder().decode(bytes) : null;
        done({
          state: "file",
          view: { path: source.name, name: source.name, kind, size: bytes.byteLength, mediaType: source.mediaType ?? "", text, language: null, tooBig: big },
          bytes: kind === "pdf" || kind === "image" ? bytes : null,
        });
      } catch (e) {
        done({ state: "error", message: String(e instanceof Error ? e.message : e) });
      }
    })();
    return () => {
      stale = true;
    };
  }, [source, compileTex]);
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

/** A picture, fitted to the viewer or at its own size. */
function ImageView({ bytes, name, mediaType }: { bytes: ArrayBuffer; name: string; mediaType: string }) {
  const [actual, setActual] = useState(false);
  const src = useMemo(() => `data:${imageType(name, mediaType)};base64,${bytesToBase64(bytes)}`, [bytes, name, mediaType]);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" aria-pressed={actual} onClick={() => setActual(!actual)}>
          {actual ? "Fit to the window" : "Actual size"}
        </Button>
      </div>
      <div tabIndex={0} role="region" aria-label={name} className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-surface-sunken p-3">
        <img src={src} alt={name} className={cn("mx-auto", actual ? "max-w-none" : "max-h-full max-w-full object-contain")} data-viewer-image="" />
      </div>
    </div>
  );
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
function Body({ source, loaded, base, onCompile }: { source: ViewSource; loaded: Loaded; base: string; onCompile: () => void }) {
  if (loaded.state === "loading") {
    return (
      <p role="status" className="text-ink-secondary">
        {source.kind === "latex" ? "Making the PDF… (this can take a few seconds)" : "Opening…"}
      </p>
    );
  }
  if (loaded.state === "error") {
    return (
      <p role="alert" className="rounded-md border border-danger bg-danger-soft px-3 py-2 text-danger-ink" data-viewer-error="">
        {loaded.message}
      </p>
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
      return bytes ? <PdfView data={bytes} label={view.name} className="min-h-0 flex-1" /> : null;
    case "image":
      return bytes ? <ImageView bytes={bytes} name={view.name} mediaType={view.mediaType} /> : null;
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
      return <CodeView text={view.text ?? ""} language={view.language} label={view.name} />;
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
    <div className="flex flex-wrap items-center justify-end gap-2">
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
    </div>
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
  const loaded = useLoaded(source, compileTex);
  const title = source.kind === "latex" ? source.title : source.kind === "space" ? nameOf(source.path) : source.name;
  const base = source.kind === "space" ? dirOf(source.path) : "";
  return (
    <DialogContent
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
        <DialogDescription className="text-sm wrap-anywhere">{describe(source, loaded)}</DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col" data-viewer-body="">
        <Body source={source} loaded={loaded} base={base} onCompile={() => setCompileTex(true)} />
      </div>
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
  children,
  className,
  ...rest
}: { space: string; path: string; children?: ReactNode; className?: string } & Omit<React.ComponentProps<"button">, "onClick" | "type">) {
  const { open, viewer } = useFileViewer();
  return (
    <>
      <button
        type="button"
        className={cn("cursor-pointer text-start text-accent-ink underline decoration-1 underline-offset-2 hover:decoration-2", className)}
        onClick={() => open({ kind: "space", space, path })}
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
