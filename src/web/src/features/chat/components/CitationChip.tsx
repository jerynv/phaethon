import { AlertTriangleIcon, FileTextIcon, LoaderIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { studyCitationsCheck, type CitationCheck } from "../api";
import { useSpaceId } from "../context";
import { citeName } from "../lib/study-cite";

// Every chip shown in the same moment asks the core once.
type Waiting = { path: string; quote: string; resolve: (c: CitationCheck) => void };
const cache = new Map<string, Promise<CitationCheck>>();
const queue = new Map<string, Waiting[]>();

function check(space: string, path: string, quote: string): Promise<CitationCheck> {
  const key = `${space}\n${path}\n${quote}`;
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
        studyCitationsCheck(space, batch.map((b) => ({ path: b.path, quote: b.quote }))).then(
          (got) => batch.forEach((b, i) => b.resolve(got[i] ?? { found: false, path: b.path, name: citeName(b.path), why: "It couldn’t be checked." })),
          () => batch.forEach((b) => b.resolve({ found: false, path: b.path, name: citeName(b.path), why: "It couldn’t be checked just now." })),
        );
      });
  });
  cache.set(key, p);
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return p;
}

/**
 * A `[source: … "…"]` in a reply, as a chip that says whether those words are
 * in that file: found (opens the passage, then the file), or "not found in
 * your materials" in words and an icon, never colour alone.
 */
export function CitationChip({ path, quote }: { path: string; quote: string }) {
  const space = useSpaceId();
  const openFile = useNav((s) => s.openFile);
  const [got, setGot] = useState<CitationCheck | null>(null);
  useEffect(() => {
    let live = true;
    if (space) void check(space, path, quote).then((c) => live && setGot(c));
    return () => {
      live = false;
    };
  }, [space, path, quote]);
  const name = got?.name ?? citeName(path);
  const where = got?.at ? ` ${got.at}` : "";
  const state = !got ? "checking" : got.found ? "found" : "missing";
  const label =
    state === "checking"
      ? `Source: ${name}, being checked`
      : state === "found"
        ? `Source: ${name}${where}, found in your materials`
        : `Source: ${name}, not found in your materials`;
  const Icon = state === "checking" ? LoaderIcon : state === "found" ? FileTextIcon : AlertTriangleIcon;
  return (
    <Dialog>
      <DialogTrigger
        aria-label={label}
        data-citation={state}
        className={cn(
          "mx-0.5 inline-flex min-h-6 max-w-full cursor-pointer items-center gap-1 rounded-full border px-2 py-px align-baseline text-[0.8125rem] leading-snug no-underline transition-colors",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring forced-colors:border-[ButtonText]",
          state === "missing"
            ? "border-warning/40 bg-warning/10 text-warning-foreground"
            : "border-border bg-muted/60 text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Icon aria-hidden className={cn("size-3.5 shrink-0", state === "checking" && "animate-spin motion-reduce:animate-none")} />
        <span aria-hidden className="truncate">
          {name}
          {where}
        </span>
        {state === "missing" && (
          <span aria-hidden className="shrink-0 font-medium">
            · not found
          </span>
        )}
      </DialogTrigger>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-lg">
            {name}
            {where}
          </DialogTitle>
          <DialogDescription>
            {state === "found"
              ? got?.page
                ? `Found on page ${got.page}.`
                : "Found in your materials."
              : state === "missing"
                ? `Not found in your materials. ${got?.why ?? ""} Treat what it supports with care.`
                : "Checking whether these words are in the file…"}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {state === "found" && got?.passage ? (
            <blockquote className="border-s-2 ps-3 text-[0.9375rem] leading-relaxed text-muted-foreground">
              {got.before && <span>{got.before}</span>}
              <mark className="rounded-sm bg-primary/12 px-0.5 font-semibold text-foreground forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]">
                {got.passage}
              </mark>
              {got.after && <span>{got.after}</span>}
            </blockquote>
          ) : (
            <blockquote className="border-s-2 ps-3 text-[0.9375rem] leading-relaxed text-muted-foreground">“{quote}”</blockquote>
          )}
          {state === "found" && got && (
            <Button variant="outline" size="sm" className="mt-4" onClick={() => openFile(got.path, space)}>
              <FileTextIcon aria-hidden />
              Open {name}
              {got.page ? `, page ${got.page}` : ""}
            </Button>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
