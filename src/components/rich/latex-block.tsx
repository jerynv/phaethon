import { useContext, useEffect, useState } from "react";

import { SpaceIdContext } from "@/components/chat/approval-card";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { SpaceFileLink, useFileViewer } from "@/components/viewer/file-viewer";
import { Icon } from "@/icons";
import { latexCompile, latexPdf, latexSave, latexStatus, latexTitle, type LatexOutcome, type LatexSaved } from "@/lib/latex";
import { cn } from "@/lib/utils";

import { ShowSource, SourceBlock } from "./source";

/** Whether LaTeX is installed, once known: null while asking. */
function useEngineMessage(): string | null | undefined {
  const [message, setMessage] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let stale = false;
    void latexStatus().then((s) => !stale && setMessage(s.engine ? null : (s.message ?? "There’s no LaTeX on this computer.")));
    return () => {
      stale = true;
    };
  }, []);
  return message;
}

/** Save to space, and what it saved as links into the viewer. */
function SaveToSpace({ source, title, figure }: { source: string; title: string; figure?: boolean }) {
  const space = useContext(SpaceIdContext);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<LatexSaved | null>(null);
  const [problem, setProblem] = useState("");
  if (!space) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={saving}
        data-latex-save=""
        onClick={async () => {
          setSaving(true);
          setProblem("");
          try {
            setSaved(await latexSave(space, source, title, figure));
          } catch (e) {
            setProblem(`It couldn’t be saved: ${String(e)}`);
          } finally {
            setSaving(false);
          }
        }}
      >
        <Icon name="download" />
        {saving ? "Saving…" : "Save to space"}
      </Button>
      {(saved || problem) && (
        <p role={problem ? "alert" : "status"} className={cn("basis-full text-sm", problem ? "text-danger-ink" : "text-ink-secondary")} data-latex-saved="">
          {problem || (
            <>
              Saved <SpaceFileLink space={space} path={saved!.tex} className="font-mono" />
              {saved!.pdf && (
                <>
                  {" "}
                  and <SpaceFileLink space={space} path={saved!.pdf} className="font-mono" />
                </>
              )}
              .{saved!.note && ` ${saved!.note}`}
            </>
          )}
        </p>
      )}
    </>
  );
}

/**
 * A whole LaTeX document in a reply (a ```latex fence with \documentclass),
 * as a card: its title, View (compiled on this computer and shown as a PDF
 * in the app), Save to space (the .tex and its PDF in documents/), and its
 * source one fold below. Without LaTeX installed it says how to get it, and
 * the source is still there.
 */
export function LatexDocumentCard({ source }: { source: string }) {
  const title = latexTitle(source);
  const space = useContext(SpaceIdContext);
  const engine = useEngineMessage();
  const { open, viewer } = useFileViewer();
  return (
    <section
      aria-label={`LaTeX document: ${title}`}
      className="my-4 flex w-full max-w-(--ph-measure) flex-col gap-2 rounded-xl border border-line bg-raised p-3 shadow-sm first:mt-0"
      data-latex-card=""
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex size-(--ph-control-height-lg) shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-secondary">
          <Icon name="file-text" />
        </span>
        <div className="flex min-w-0 flex-col">
          <p className="font-semibold wrap-anywhere text-ink" data-latex-title="">
            {title}
          </p>
          <p className="text-sm text-ink-secondary">LaTeX document</p>
        </div>
      </div>
      {engine && (
        <p className="flex items-start gap-2 rounded-md bg-surface px-3 py-2 text-sm text-ink" data-latex-no-engine="">
          <Icon name="info" className="mt-0.5 shrink-0 text-ink-secondary" />
          <span>{engine}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!engine && (
          <Button
            type="button"
            size="sm"
            data-latex-view=""
            disabled={engine === undefined}
            onClick={() => open({ kind: "latex", title, source, space: space || undefined })}
          >
            <Icon name="file-text" />
            View<span className="sr-only"> {title} as a PDF</span>
          </Button>
        )}
        <SaveToSpace source={source} title={title} />
      </div>
      <ShowSource code={source} what="document" />
      {viewer}
    </section>
  );
}

/** One figure's compile and picture. */
type Figure =
  | { state: "drawing" }
  | { state: "drawn"; src: string; width: number; height: number; text: string }
  | { state: "problem"; outcome: Exclude<LatexOutcome, { status: "ok" }> | { status: "unavailable"; message: string } };

/**
 * A ```tikz fence drawn as a picture in the reply: compiled on this
 * computer as a page of its own, cropped, and drawn with pdf.js. Its labels
 * are its text alternative (the reply says what it shows); a larger view and
 * its source are one step away. A figure that can't be drawn says why and
 * shows its source.
 */
export function TikzFigure({ source }: { source: string }) {
  const [fig, setFig] = useState<Figure>({ state: "drawing" });
  const { open, viewer } = useFileViewer();
  const space = useContext(SpaceIdContext);
  useEffect(() => {
    let stale = false;
    setFig({ state: "drawing" });
    void (async () => {
      const outcome = await latexCompile(source, true);
      if (stale) return;
      if (outcome.status !== "ok") {
        setFig({ state: "problem", outcome });
        return;
      }
      try {
        const [{ figurePicture }, bytes] = await Promise.all([import("./pdf"), latexPdf(outcome.id)]);
        const pic = await figurePicture(bytes);
        if (!stale) setFig({ state: "drawn", ...pic });
      } catch (e) {
        if (!stale) setFig({ state: "problem", outcome: { status: "unavailable", message: `The figure couldn’t be drawn: ${String(e)}` } });
      }
    })();
    return () => {
      stale = true;
    };
  }, [source]);

  const alt = fig.state === "drawn" ? (fig.text ? `Figure, labelled: ${fig.text}` : "Figure drawn from TikZ") : "";
  return (
    <figure className="my-4 flex w-full flex-col items-start gap-1 first:mt-0" data-tikz-figure={fig.state}>
      {fig.state === "drawing" && (
        <p role="status" className="text-sm text-ink-secondary">
          Drawing the figure…
        </p>
      )}
      {fig.state === "drawn" && (
        <button
          type="button"
          className="max-w-full cursor-zoom-in rounded-lg border border-line bg-(--ph-pdf-paper) p-2"
          onClick={() => open({ kind: "latex", title: "Figure", source, figure: true, space: space || undefined })}
          aria-label={`${alt}. Open it larger`}
          data-tikz-open=""
        >
          <img
            src={fig.src}
            alt=""
            width={Math.round(fig.width)}
            height={Math.round(fig.height)}
            className="h-auto max-h-(--ph-figure-max-height) w-auto max-w-full object-contain"
          />
        </button>
      )}
      {fig.state === "problem" && (
        <div className="flex w-full flex-col gap-2" data-tikz-problem={fig.outcome.status}>
          <p role="note" className="flex items-start gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink">
            <Icon name={fig.outcome.status === "failed" ? "warning" : "info"} className="mt-0.5 shrink-0 text-ink-secondary" />
            <span>
              {fig.outcome.status === "failed" ? "This figure couldn’t be drawn. " : ""}
              {fig.outcome.message}
            </span>
          </p>
          {fig.outcome.status === "failed" && fig.outcome.log && (
            <Details summary="Show LaTeX’s log">
              <SourceBlock code={fig.outcome.log} label="LaTeX’s log" />
            </Details>
          )}
          <SourceBlock code={source} label="The figure’s source" />
        </div>
      )}
      {fig.state !== "problem" && <ShowSource code={source} what="figure" />}
      {viewer}
    </figure>
  );
}
