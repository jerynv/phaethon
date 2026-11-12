import { FileTextIcon, QuoteIcon } from "lucide-react";
import { useState } from "react";
import { useNav } from "@/app/store";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "@/components/ui/preview-card";
import { Spinner } from "@/components/ui/spinner";
import { errorText } from "@/lib/core";
import { studyCitationsCheck, type CitationCheck } from "../api";
import { citeName, type Citation } from "../lib/study-cite";

/** An inline source: the file's name as a chip; hovering checks the quote against the file. */
export function CitationChip({ space, citation }: { space: string; citation: Citation }) {
  const openFile = useNav((s) => s.openFile);
  const [check, setCheck] = useState<CitationCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    if (check || error) return;
    studyCitationsCheck(space, [citation]).then(
      (r) => setCheck(r[0] ?? null),
      (e) => setError(errorText(e)),
    );
  };
  return (
    <PreviewCard onOpenChange={(o) => o && load()}>
      <PreviewCardTrigger
        render={
          <button
            type="button"
            onClick={() => openFile(space, check?.path ?? citation.path)}
            className="mx-0.5 inline-flex max-w-52 translate-y-[-1px] items-center gap-1 rounded-md border bg-muted/60 px-1.5 align-middle font-medium text-2xs text-muted-foreground leading-5 hover:text-foreground"
          />
        }
      >
        <FileTextIcon className="size-3 shrink-0" strokeWidth={2} />
        <span className="truncate">{citeName(citation.path)}</span>
      </PreviewCardTrigger>
      <PreviewCardPopup className="w-80">
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <FileTextIcon className="size-3.5 text-muted-foreground" />
            <span className="truncate">{check?.name ?? citeName(citation.path)}</span>
            {check?.page ? <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">p. {check.page}</span> : null}
          </div>
          <blockquote className="flex gap-1.5 border-l-2 pl-2 text-muted-foreground">
            <QuoteIcon className="mt-0.5 size-3 shrink-0" />
            <span className="line-clamp-6">{check?.passage ?? citation.quote}</span>
          </blockquote>
          {check === null && !error ? (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <Spinner size="xs" /> Checking the quote…
            </span>
          ) : error ? (
            <span className="text-error-foreground">Couldn’t check: {error}</span>
          ) : check && !check.found ? (
            <span className="text-warning-foreground">{check.why ?? "This quote isn’t in that file."}</span>
          ) : (
            <span className="text-success-foreground">Found in the file</span>
          )}
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}
