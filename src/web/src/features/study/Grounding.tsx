/**
 * Where practice comes from: a card's or question's passages (SourceLine),
 * and what a generated quiz or deck covers and what the check left out
 * (GroundingSummary). Every passage opens its file in the viewer.
 */
import { BookOpenIcon, ChevronRightIcon, FileTextIcon, TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useNav } from "@/app/nav";
import { cn } from "@/lib/utils";

import { MathText } from "./CardText";
import { tidyScope } from "./lib/quiz-answers";
import type { Evidence, Grounding, MaterialAlert } from "./lib/types";
import { evidencePage, plural, sourceWords } from "./lib/words";

/** A disclosure with a quiet summary line. */
export function Disclosure({ summary, children, className, defaultOpen }: { summary: ReactNode; children: ReactNode; className?: string; defaultOpen?: boolean }) {
  return (
    <details className={cn("group/disc", className)} open={defaultOpen}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md py-0.5 text-sm text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 transition-transform group-open/disc:rotate-90 motion-reduce:transition-none" />
        {summary}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

/** One passage: the quoted words and a link to open the file at its page. */
export function Passage({ e, space }: { e: Evidence; space: string }) {
  const openFile = useNav((s) => s.openFile);
  const fromUser = e.source === "from you";
  const page = evidencePage(e);
  return (
    <figure className="flex flex-col gap-1.5 border-s-2 border-primary/40 ps-3">
      <blockquote className="text-sm leading-relaxed text-foreground">
        <MathText text={`“${e.quote}”`} />
      </blockquote>
      <figcaption className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
        {fromUser ? (
          "You said this"
        ) : (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline decoration-border underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => openFile(e.source, space)}
          >
            <FileTextIcon aria-hidden className="size-3.5" />
            {sourceWords(e)}
            {page && !e.at ? `, page ${page}` : ""}
          </button>
        )}
      </figcaption>
    </figure>
  );
}

/** "From Rosen chapter 2 §2.1", with the passages one click away. */
export function SourceLine({ cites, space, className }: { cites: Evidence[]; space: string; className?: string }) {
  if (!cites.length) return null;
  return (
    <Disclosure
      className={className}
      summary={
        <span className="inline-flex items-center gap-1.5">
          <BookOpenIcon aria-hidden className="size-3.5" />
          From {cites.map(sourceWords).join("; ")}
        </span>
      }
    >
      <div className="flex flex-col gap-3">
        {cites.map((e, i) => (
          <Passage key={i} e={e} space={space} />
        ))}
      </div>
    </Disclosure>
  );
}

/** A note about the course's material (handwriting read by recognition, pictures the model can't see). */
export function MaterialNote({ alert }: { alert?: MaterialAlert }) {
  if (!alert) return null;
  return (
    <p className="flex items-start gap-2 rounded-lg border border-warning/32 bg-warning-surface px-3 py-2 text-sm text-warning-foreground" data-material-alert={alert.kind}>
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{alert.text}</span>
    </p>
  );
}

/** What a generated set covers, where its exam scope comes from, and what the check dropped. */
export function GroundingSummary({ g, space, noun }: { g: Grounding; space: string; noun: "question" | "card" }) {
  const covered = g.coverage.filter((c) => c.count > 0).length;
  return (
    <div className="flex flex-col gap-3 text-sm">
      {g.exam && (
        <p className="text-foreground">
          <span className="font-medium">{g.exam}:</span> {g.scope ? tidyScope(g.scope) : "its topics"}
          {g.fromUser && <span className="text-muted-foreground"> (as you said)</span>}
        </p>
      )}
      <p className="text-muted-foreground">
        {g.kept} of {plural(g.asked, noun)} passed the check against your course files.
      </p>
      {g.notes?.map((n, i) => (
        <p key={i} className="flex items-start gap-2 text-warning-foreground">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {n}
        </p>
      ))}
      {g.coverage.length > 0 && (
        <Disclosure summary={`Covers ${covered} of ${plural(g.coverage.length, "topic")}`}>
          <ul className="flex flex-col gap-1.5">
            {g.coverage.map((c, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-x-4">
                <span className="text-foreground">
                  {c.topic}
                  {c.sections && <span className="text-muted-foreground"> {c.sections}</span>}
                </span>
                <span className="text-muted-foreground tabular-nums">{c.count > 0 ? plural(c.count, noun) : `none, ${c.why ?? "not found"}`}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {g.exam && g.evidence.length > 0 && (
        <Disclosure summary={`Where ${g.exam}’s scope comes from`}>
          <div className="flex flex-col gap-3">
            {g.evidence.map((e, i) => (
              <Passage key={i} e={e} space={space} />
            ))}
          </div>
        </Disclosure>
      )}
      {g.dropped.length > 0 && (
        <Disclosure summary={`Left out by the check: ${g.dropped.length}`}>
          <ul className="flex flex-col gap-2">
            {g.dropped.map((d, i) => (
              <li key={i}>
                <MathText text={`“${d.text}”`} className="text-foreground" />
                <span className="text-muted-foreground"> {d.why}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
