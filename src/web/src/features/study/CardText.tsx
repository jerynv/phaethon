/**
 * Study text with math drawn by KaTeX (MathML for screen readers), and cloze
 * blanks shown as gaps until revealed. Invalid TeX shows as its source.
 */
import katex from "katex";
import { Fragment, useMemo } from "react";

import { cn } from "@/lib/utils";

import { mathPieces, texStrings } from "./lib/math";
import { clozePieces } from "./lib/words";

const cache = new Map<string, string | null>();

function render(tex: string, display: boolean): string | null {
  const key = `${display ? "D" : "I"}${tex}`;
  if (cache.has(key)) return cache.get(key)!;
  if (cache.size > 2000) cache.clear();
  let html: string | null;
  try {
    html = katex.renderToString(texStrings(tex), { output: "htmlAndMathml", throwOnError: true, trust: false, strict: "ignore", maxSize: 20, maxExpand: 200, displayMode: display });
  } catch {
    html = null;
  }
  cache.set(key, html);
  return html;
}

export function MathText({ text, className }: { text: string; className?: string }) {
  const pieces = useMemo(() => mathPieces(text), [text]);
  return (
    <span className={cn("whitespace-pre-wrap", className)}>
      {pieces.map((p, i) => {
        if (!p.math) return <Fragment key={i}>{p.text}</Fragment>;
        const html = render(p.text, p.display);
        if (html == null) return <code key={i} className="font-mono text-[0.9em]">{p.display ? `$$${p.text}$$` : `$${p.text}$`}</code>;
        return p.display ? (
          <span key={i} className="my-2 block overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <span key={i} dangerouslySetInnerHTML={{ __html: html }} />
        );
      })}
    </span>
  );
}

/**
 * A card or question with its blanks: a gap until `reveal`, then the answer
 * marked. `___` in a question reads as a blank too.
 */
export function CardText({ text, reveal = false, className }: { text: string; reveal?: boolean; className?: string }) {
  const src = text.replace(/_{3,}/g, "{{ }}");
  const pieces = useMemo(() => clozePieces(src), [src]);
  if (!pieces.some((p) => p.blank)) return <MathText text={text} className={className} />;
  return (
    <span className={cn("whitespace-pre-wrap", className)}>
      {pieces.map((p, i) =>
        !p.blank ? (
          <MathText key={i} text={p.text} />
        ) : reveal && p.text.trim() ? (
          <mark key={i} className="rounded bg-primary/12 px-1 font-semibold text-foreground underline decoration-primary decoration-2 underline-offset-4">
            <MathText text={p.text} />
          </mark>
        ) : (
          <span key={i} className="mx-0.5 inline-block w-[5ch] translate-y-[0.1em] border-b-2 border-foreground/60" aria-label="blank" role="img" />
        ),
      )}
    </span>
  );
}
