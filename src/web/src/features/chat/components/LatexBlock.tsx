import { DownloadIcon, FileWarningIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ClampedText } from "@/components/errors";
import { toast } from "@/components/toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { errorText, invoke } from "@/lib/core";
import { openPdf, renderPage } from "@/lib/pdf";
import { cn } from "@/lib/utils";
import { CodeBlock, CopyButton } from "./CodeBlock";

type Outcome =
  | { status: "ok"; id: string; engine: string }
  | { status: "failed"; message: string; line: number | null; log: string }
  | { status: "noEngine"; message: string }
  | { status: "unavailable"; message: string };

function PdfPages({ id }: { id: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pages, setPages] = useState(0);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const bytes = await invoke<ArrayBuffer>("latex_pdf", { id });
        const doc = await openPdf(bytes);
        if (!live || !box.current) return;
        setPages(doc.numPages);
        const width = Math.min(box.current.clientWidth - 2, 720);
        const canvases = [...box.current.querySelectorAll("canvas")];
        for (let i = 0; i < Math.min(doc.numPages, canvases.length); i++) await renderPage(doc, i + 1, canvases[i]!, width);
      } catch (e) {
        if (live) setError(errorText(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [id]);
  if (error) return <p className="p-3 text-muted-foreground text-xs">Couldn’t show the PDF: {error}</p>;
  return (
    <div ref={box} className="flex max-h-[32rem] flex-col items-center gap-2 overflow-auto bg-muted/40 p-3">
      {Array.from({ length: Math.max(1, Math.min(pages, 12)) }, (_, i) => (
        <canvas key={i} className={cn("rounded-sm bg-white shadow-xs", pages === 0 && "h-40 w-full animate-skeleton")} />
      ))}
      {pages > 12 ? <p className="text-muted-foreground text-xs">First 12 of {pages} pages. Save it to see the rest.</p> : null}
    </div>
  );
}

/** A LaTeX document compiled on this computer and shown as its PDF, with its source one tab away. */
export function LatexBlock({ source, space, streaming }: { source: string; space: string; streaming: boolean }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [tab, setTab] = useState<"pdf" | "source">("pdf");
  const [saving, setSaving] = useState(false);
  const figure = !/\\documentclass/.test(source);
  useEffect(() => {
    if (streaming) return;
    let live = true;
    setOutcome(null);
    invoke<Outcome>("latex_compile", { source, figure }).then(
      (o) => live && setOutcome(o),
      (e) => live && setOutcome({ status: "unavailable", message: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [source, figure, streaming]);

  if (streaming) return <CodeBlock code={source} lang="latex" />;
  const save = async () => {
    setSaving(true);
    try {
      const title = /\\title\{([^}]{1,80})\}/.exec(source)?.[1] ?? "document";
      const saved = await invoke<{ tex: string; pdf: string | null; note: string | null }>("latex_save", { space, source, title, figure });
      toast.success("Saved to the space", saved.pdf ?? saved.tex);
    } catch (e) {
      toast.error("Couldn’t save the document", errorText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="md-code my-3">
      <div className="flex h-8 items-center gap-1 border-b px-2">
        <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
          {(["pdf", "source"] as const).map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)} className={cn("h-5 rounded-[5px] px-1.5 font-medium text-2xs", tab === t ? "bg-background text-foreground shadow-xs/5 dark:bg-white/10" : "text-muted-foreground hover:text-foreground")}>
              {t === "pdf" ? "PDF" : "LaTeX"}
            </button>
          ))}
        </div>
        <span className="ml-1.5 min-w-0 flex-1 truncate text-2xs text-muted-foreground">
          {outcome === null ? (
            <span className="inline-flex items-center gap-1.5">
              <Spinner size="xs" /> Compiling…
            </span>
          ) : outcome.status === "ok" ? (
            `Compiled with ${outcome.engine}`
          ) : null}
        </span>
        <CopyButton text={source} className="size-6" label="Copy LaTeX" />
        <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60">
          {saving ? <Spinner size="xs" /> : <DownloadIcon className="size-3" />}
          Save
        </button>
      </div>
      {tab === "source" ? (
        <pre className="md-code-body"><code>{source}</code></pre>
      ) : outcome === null ? (
        <div className="p-3">
          <Skeleton className="h-48 w-full rounded-md" />
        </div>
      ) : outcome.status === "ok" ? (
        <PdfPages id={outcome.id} />
      ) : (
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-start gap-2 text-sm">
            <FileWarningIcon className="mt-0.5 size-4 shrink-0 text-warning" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{outcome.status === "failed" ? `Didn’t compile${outcome.line ? ` (line ${outcome.line})` : ""}` : outcome.status === "noEngine" ? "No TeX on this computer" : "Can’t compile here"}</p>
              <ClampedText className="text-muted-foreground text-xs" text={outcome.message} />
            </div>
          </div>
          {outcome.status === "failed" && outcome.log ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">TeX log</summary>
              <pre className="mt-1.5 max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-2xs">{outcome.log}</pre>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}
