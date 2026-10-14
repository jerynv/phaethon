import { invoke } from "@tauri-apps/api/core";

/** Mirrors `Outcome` in src-tauri/src/latex.rs. */
export type LatexOutcome =
  | { status: "ok"; id: string; engine: string }
  | { status: "failed"; message: string; line: number | null; log: string }
  | { status: "noEngine"; message: string }
  | { status: "unavailable"; message: string };

/** Mirrors `Saved` in src-tauri/src/latex.rs: paths in the space. */
export type LatexSaved = { tex: string; pdf: string | null; note: string | null };

/** Mirrors `Status` in src-tauri/src/latex.rs. */
export type LatexStatus = { engine: string | null; engines: string[]; message: string | null };

const compiled = new Map<string, Promise<LatexOutcome>>();

/**
 * Compile a document (or, with `figure`, a ```tikz figure's body) on this
 * computer, inside the core's walls. The same source is asked once per
 * session (the core caches the PDF itself across sessions); a failure that
 * isn't the document's own is asked again next time.
 */
export function latexCompile(source: string, figure = false): Promise<LatexOutcome> {
  const key = `${figure ? "f" : "d"}:${source}`;
  let p = compiled.get(key);
  if (!p) {
    p = invoke<LatexOutcome>("latex_compile", { source, figure }).catch((e) => ({ status: "unavailable" as const, message: String(e) }));
    compiled.set(key, p);
    void p.then((o) => {
      if (o.status === "unavailable" || o.status === "noEngine") compiled.delete(key);
    });
  }
  return p;
}

/** A compiled PDF's bytes (a fresh copy each time: pdf.js takes the buffer it is given). */
export const latexPdf = (id: string) => invoke<ArrayBuffer>("latex_pdf", { id });

/** Write the source (and its PDF when it compiles) into the space's documents/ folder. */
export const latexSave = (space: string, source: string, title: string, figure = false) =>
  invoke<LatexSaved>("latex_save", { space, source, title, figure });

let status: Promise<LatexStatus> | null = null;
/** Which engine would compile here, or how to install one. Asked once per session. */
export function latexStatus(): Promise<LatexStatus> {
  status ??= invoke<LatexStatus>("latex_status").catch(() => ({ engine: null, engines: [], message: null }));
  return status;
}

/** Whether a ```latex fence holds a whole document (rather than a snippet). */
export const isLatexDocument = (source: string) => /\\documentclass\b/.test(source);

/** A TeX argument's text without the TeX: \textbf{x} → x, ~ → space, \\ → space. */
export function plainTex(s: string): string {
  return s
    .replace(/\\\\(\[[^\]]*\])?/g, " ")
    .replace(/\\(?:textbf|textit|emph|textsc|texttt|mathrm|mathbf|text|large|Large|LARGE|huge|Huge|bfseries|itshape|normalfont)\b\s*/g, "")
    .replace(/\\[a-zA-Z@]+\*?/g, "")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The argument of the first `\cmd{...}` (braces balanced), or null. */
function argOf(source: string, cmd: string): string | null {
  const m = new RegExp(`\\\\${cmd}\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{`).exec(source);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
  }
  return depth === 0 ? source.slice(start, i - 1) : null;
}

/** A document's title: its \title, else its first heading, else "LaTeX document". */
export function latexTitle(source: string): string {
  for (const cmd of ["title", "section", "chapter", "subsection"]) {
    const a = argOf(source, cmd);
    const t = a !== null ? plainTex(a) : "";
    if (t) return t.length > 120 ? `${t.slice(0, 119)}…` : t;
  }
  return "LaTeX document";
}
