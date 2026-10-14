import "katex/dist/katex.min.css";

import katex from "katex";
import { memo } from "react";

import { mathPieces } from "@/lib/study-math";

import { clozePieces } from "./words";

/** Drawn formulas by source, so a question re-rendering doesn't lay them out again. */
const drawn = new Map<string, string | null>();

/**
 * One formula as KaTeX HTML with MathML beside it (screen readers read the
 * MathML; the drawn part is hidden from them). Null when it isn't valid TeX,
 * so the caller shows the source instead of an error in red.
 */
function draw(tex: string, display: boolean): string | null {
  const key = `${display ? "D" : "I"}${tex}`;
  if (drawn.has(key)) return drawn.get(key)!;
  let html: string | null;
  try {
    html = katex.renderToString(tex, { displayMode: display, output: "htmlAndMathml", throwOnError: true, trust: false, strict: "ignore", maxSize: 20, maxExpand: 200 });
  } catch {
    html = null;
  }
  if (drawn.size > 2000) drawn.clear();
  drawn.set(key, html);
  return html;
}

/**
 * Study text with its math drawn: `$…$`, `$$…$$`, `\(…\)` and `\[…\]` by
 * KaTeX (sized from the surrounding text, so the text-size setting applies;
 * plain words keep the reading font). A formula KaTeX can't read is shown as
 * written.
 */
export const MathText = memo(function MathText({ text }: { text: string }) {
  const pieces = mathPieces(text);
  if (!pieces.some((p) => p.math)) return <>{text}</>;
  return (
    <>
      {pieces.map((p, i) => {
        if (!p.math) return <span key={i}>{p.text}</span>;
        const html = draw(p.text, p.display);
        if (html === null) return <span key={i}>{p.display ? `$$${p.text}$$` : `$${p.text}$`}</span>;
        return (
          <span
            key={i}
            data-math={p.display ? "display" : "inline"}
            className={p.display ? "my-2 block max-w-full overflow-x-auto overflow-y-hidden" : undefined}
            // KaTeX's own output for a formula, made with trust off (no links, no raw HTML).
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      })}
    </>
  );
});

/**
 * A card's text as shown: a cloze blank ({{answer}}) is a gap on the front,
 * and the word itself, underlined and bold, once revealed (never colour
 * alone). Math in it is drawn (MathText). Decorative where the caller gives
 * screen readers the words.
 */
export function CardText({ text, reveal = false }: { text: string; reveal?: boolean }) {
  return (
    <>
      {clozePieces(text).map((p, i) =>
        !p.blank ? (
          <MathText key={i} text={p.text} />
        ) : reveal ? (
          <span key={i} className="font-semibold underline decoration-2 underline-offset-4">
            <MathText text={p.text} />
          </span>
        ) : (
          <span
            key={i}
            data-blank=""
            className="mx-0.5 inline-block min-w-[4ch] border-b-2 border-ink-secondary align-baseline forced-colors:border-[CanvasText]"
          >
            &nbsp;
          </span>
        ),
      )}
    </>
  );
}
