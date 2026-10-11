import { clozePieces } from "./words";

/**
 * A card's text as shown: a cloze blank ({{answer}}) is a gap on the front,
 * and the word itself, underlined and bold, once revealed (never colour
 * alone). Decorative: the caller gives screen readers the words.
 */
export function CardText({ text, reveal = false }: { text: string; reveal?: boolean }) {
  return (
    <>
      {clozePieces(text).map((p, i) =>
        !p.blank ? (
          <span key={i}>{p.text}</span>
        ) : reveal ? (
          <span key={i} className="font-semibold underline decoration-2 underline-offset-4">
            {p.text}
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
