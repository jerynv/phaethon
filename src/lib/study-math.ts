/**
 * Math in study text (quiz questions, flashcards): `$…$` inline, `$$…$$`
 * on its own line, and `\(…\)` / `\[…\]`. Split here, drawn by KaTeX in
 * card-text.tsx. A lone dollar ("costs $5") stays text: an opening `$` is
 * never followed by a space, a closing one never follows a space or comes
 * right before a digit, and `\$` is a dollar sign.
 */
export type MathPiece = { text: string; math: false } | { text: string; math: true; display: boolean };

export function mathPieces(src: string): MathPiece[] {
  const out: MathPiece[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ text: plain.replace(/\\\$/g, "$"), math: false });
    plain = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && (src[i + 1] === "(" || src[i + 1] === "[")) {
      const close = src[i + 1] === "(" ? "\\)" : "\\]";
      const end = src.indexOf(close, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ text: src.slice(i + 2, end).trim(), math: true, display: close === "\\]" });
        i = end + 2;
        continue;
      }
    }
    if (ch === "\\" && src[i + 1] === "$") {
      plain += "\\$";
      i += 2;
      continue;
    }
    if (ch === "$" && src[i + 1] === "$") {
      const end = src.indexOf("$$", i + 2);
      if (end > i + 2 && src.slice(i + 2, end).trim()) {
        flush();
        out.push({ text: src.slice(i + 2, end).trim(), math: true, display: true });
        i = end + 2;
        continue;
      }
    }
    if (ch === "$" && src[i + 1] && !/\s/.test(src[i + 1]) && src[i + 1] !== "$") {
      let j = i + 1;
      let found = -1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "$") {
          if (!/\s/.test(src[j - 1]) && !/\d/.test(src[j + 1] ?? "")) found = j;
          break;
        }
        j++;
      }
      if (found > i + 1) {
        flush();
        out.push({ text: src.slice(i + 1, found), math: true, display: false });
        i = found + 1;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

/** Whether `src` has any math to draw. */
export const hasMath = (src: string) => mathPieces(src).some((p) => p.math);

/**
 * The text with its math delimiters taken off, for places that can't draw
 * math (an announcement, a title): `$\lambda$` reads as `\lambda`.
 */
export const mathAsText = (src: string) => mathPieces(src).map((p) => p.text).join("");
