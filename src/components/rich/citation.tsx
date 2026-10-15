import { useContext, useEffect, useState } from "react";

import { SpaceIdContext } from "@/components/chat/approval-card";
import { SpaceFileLink } from "@/components/viewer/file-viewer";
import { Details } from "@/components/ui/details";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Icon } from "@/icons";
import { studyCitationsCheck, type CitationCheck, type Evidence } from "@/lib/study";
import { citeName } from "@/lib/study-cite";
import { cn } from "@/lib/utils";

// ---- Checking, batched: every chip shown in the same moment asks the core once ----

type Pending = { path: string; quote: string; resolve: (c: CitationCheck) => void };
const cache = new Map<string, Promise<CitationCheck>>();
const queue = new Map<string, Pending[]>();
const keyOf = (space: string, path: string, quote: string) => `${space}\n${path}\n${quote}`;

function check(space: string, path: string, quote: string): Promise<CitationCheck> {
  const key = keyOf(space, path, quote);
  const hit = cache.get(key);
  if (hit) return hit;
  const p = new Promise<CitationCheck>((resolve) => {
    const list = queue.get(space) ?? [];
    list.push({ path, quote, resolve });
    queue.set(space, list);
    if (list.length === 1)
      queueMicrotask(() => {
        const batch = queue.get(space) ?? [];
        queue.delete(space);
        studyCitationsCheck(
          space,
          batch.map((b) => ({ path: b.path, quote: b.quote })),
        ).then(
          (got) => batch.forEach((b, i) => b.resolve(got[i] ?? { found: false, path: b.path, name: citeName(b.path), why: "It couldn’t be checked." })),
          () => batch.forEach((b) => b.resolve({ found: false, path: b.path, name: citeName(b.path), why: "It couldn’t be checked just now." })),
        );
      });
  });
  cache.set(key, p);
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return p;
}

/** A passage in place: the words around it, the quote itself marked (bold and highlighted, never colour alone). */
export function Passage({ before, passage, after }: { before?: string; passage: string; after?: string }) {
  return (
    <blockquote className="border-s-2 border-line-strong ps-3 text-base leading-normal wrap-break-word text-ink-secondary" data-passage="">
      {before && <span>{before}</span>}
      <mark className="rounded-xs bg-accent-soft px-0.5 font-semibold text-ink forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]">{passage}</mark>
      {after && <span>{after}</span>}
    </blockquote>
  );
}

/**
 * A `[source: … "…"]` in a reply, as a chip that says whether those words are
 * in that file, as this space may read it: found (opens the passage, with the
 * file one click on), or "not found in your materials" in warning colours and
 * words, never colour alone.
 */
export function CitationChip({ path, quote }: { path: string; quote: string }) {
  const space = useContext(SpaceIdContext);
  const [got, setGot] = useState<CitationCheck | null>(null);
  useEffect(() => {
    let live = true;
    if (!space) return;
    void check(space, path, quote).then((c) => live && setGot(c));
    return () => {
      live = false;
    };
  }, [space, path, quote]);
  const name = got?.name ?? citeName(path);
  const where = got?.at ? ` ${got.at}` : "";
  const state = !got ? "checking" : got.found ? "found" : "missing";
  const label =
    state === "checking" ? `Source: ${name}, being checked` : state === "found" ? `Source: ${name}${where}, found in your materials` : `Source: ${name}, not found in your materials`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-citation={state}
          className={cn(
            "mx-0.5 inline-flex min-h-(--ph-target-min) max-w-full cursor-pointer items-center gap-1 rounded-full border px-2 align-baseline text-sm leading-tight",
            "forced-colors:border-[ButtonText]",
            state === "missing" ? "border-warning-ink bg-warning-soft text-warning-ink" : "border-line bg-surface text-ink-secondary hover:bg-hover hover:text-ink",
          )}
        >
          <Icon name={state === "checking" ? "spinner" : state === "found" ? "file-text" : "warning"} className={cn("size-(--ph-icon-size-sm) shrink-0", state === "checking" && "animate-spin")} />
          <span className="truncate" aria-hidden="true">
            {name}
            {where}
          </span>
          {state === "missing" && (
            <span aria-hidden="true" className="shrink-0 font-medium">
              · not found in your materials
            </span>
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[calc(100dvh-var(--ph-space)*8)] max-w-(--ph-measure) flex-col gap-3 overflow-y-auto" data-citation-dialog={state}>
        <DialogHeader>
          <DialogTitle className="wrap-anywhere">
            {name}
            {where}
          </DialogTitle>
          <DialogDescription>
            {state === "found"
              ? "These words are in this file, as quoted."
              : state === "missing"
                ? `Not found in your materials. ${got?.why ?? ""} Treat what it supports with care.`
                : "Checking whether these words are in the file…"}
          </DialogDescription>
        </DialogHeader>
        {state === "found" && got?.passage ? (
          <Passage before={got.before} passage={got.passage} after={got.after} />
        ) : (
          <blockquote className="border-s-2 border-line-strong ps-3 text-base wrap-break-word text-ink-secondary" data-citation-quote="">
            “{quote}”
          </blockquote>
        )}
        {state === "found" && space && (
          <div>
            <SpaceFileLink space={space} path={got!.path} className="inline-flex min-h-(--ph-target-min) items-center gap-1.5">
              <Icon name="file-text" />
              Open {name}
            </SpaceFileLink>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** "Wennstrom Lecture Notes - C241 Fa26 §5.3": a citation's file and place, in a few words. */
export function sourceWords(e: Evidence): string {
  const name = citeName(e.source).replace(/\.(pdf|md|docx|pptx|txt)$/i, "");
  const where = e.at ? `${name} ${e.at}` : name;
  // Read by the model from the page's picture: matched only roughly, so said.
  return e.picture ? `${where} (read from a picture of the page)` : where;
}

/**
 * Where a question or card comes from: "From: Lecture notes §5.3", the
 * passage one fold below with the file a click on (the in-app viewer).
 */
export function SourceLine({ space, cites, className }: { space: string; cites: Evidence[]; className?: string }) {
  if (!cites.length) return null;
  const files = [...new Set(cites.map(sourceWords))];
  return (
    <div className={cn("flex flex-col gap-1", className)} data-provenance="">
      <p className="text-sm text-ink-secondary">From: {files.join("; ")}</p>
      <Details summary={cites.length === 1 ? "Show the passage" : `Show the ${cites.length} passages`}>
        {cites.map((c, i) => (
          <div key={i} className="flex flex-col gap-1">
            <Passage passage={c.quote} />
            {c.source !== "from you" && (
              <SpaceFileLink space={space} path={c.source} className="inline-flex min-h-(--ph-target-min) items-center gap-1.5 text-sm">
                <Icon name="file-text" className="size-(--ph-icon-size-sm)" />
                Open {citeName(c.source)}
              </SpaceFileLink>
            )}
          </div>
        ))}
      </Details>
    </div>
  );
}
