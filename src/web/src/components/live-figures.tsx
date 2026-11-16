import { Fragment } from "react";

/**
 * A sentence whose numbers change while it's shown ("Sending in 0:59",
 * "Rate limited · retry in 12s"): the digit runs are set in the live type role
 * (monospaced, fixed width) so the words around them hold still; the words
 * keep the text's own font.
 */
export function LiveFigures({ text }: { text: string }) {
  const parts = text.split(/(\d[\d:.,]*\d|\d)/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="type-live">
            {p}
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
