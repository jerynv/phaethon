import { useEffect, useRef, useState } from "react";
import { useNav } from "@/app/store";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
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
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = () => {
    if (check || error || inFlight.current) return;
    inFlight.current = true;
    studyCitationsCheck(space, [citation]).then(
      (r) => {
        inFlight.current = false;
        if (mounted.current) setCheck(r[0] ?? null);
      },
      (e) => {
        inFlight.current = false;
        if (mounted.current) setError(errorText(e));
      },
    );
  };
  return (
    <PreviewCard onOpenChange={(o) => o && load()}>
      <PreviewCardTrigger
        render={
          <button
            type="button"
            onClick={() => openFile(space, check?.path ?? citation.path)}
            className="mx-0.5 inline-flex max-w-52 items-baseline gap-1 align-baseline text-[0.92em] text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground hover:decoration-current"
          />
        }
      >
        <Icon icon={icons.fileText} className="size-3 translate-y-0.5" />
        <span className="truncate">{citeName(citation.path)}</span>
      </PreviewCardTrigger>
      <PreviewCardPopup className="w-80">
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <Icon icon={icons.fileText} className="size-3.5 text-muted-foreground" />
            <span className="truncate">{check?.name ?? citeName(citation.path)}</span>
            {check?.page ? <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">p. {check.page}</span> : null}
          </div>
          <blockquote className="flex gap-1.5 border-l-2 pl-2 text-muted-foreground">
            <Icon icon={icons.quote} className="mt-0.5 size-3" />
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
