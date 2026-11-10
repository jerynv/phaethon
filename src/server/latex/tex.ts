/**
 * The pure parts of compiling model-written LaTeX: engine choice, wrapping a
 * ```tikz figure into a page, reading TeX's log in plain words, cache ids and
 * file names. Ported one-to-one from the Rust core's latex.rs, strings
 * included (the UI and tests match on them).
 */

/** The longest source compiled or saved, in UTF-8 bytes. */
export const MAX_SOURCE = 512 * 1024;
/** The largest PDF read back. */
export const MAX_PDF = 40 * 1024 * 1024;
/** The largest file TeX may write (log, aux, PDF): RLIMIT_FSIZE. */
export const MAX_FILE = 64 * 1024 * 1024;
/** How long one compile (all its runs together) may take. */
export const TIMEOUT_MS = 60_000;
/** CPU seconds per process: RLIMIT_CPU. */
export const CPU_SECONDS = (2 * TIMEOUT_MS) / 1000;
/** Runs for references and contents to settle (Tectonic: one). */
export const MAX_RUNS = 3;
/** How much of the log comes back with an error. */
export const MAX_LOG = 48 * 1024;
/** Cached PDFs kept; the oldest go first. */
export const MAX_CACHED = 200;

export const INSTALL_HINT =
  "To see LaTeX documents here, install a TeX distribution: MacTeX on a Mac (tug.org/mactex), " +
  "TeX Live on Linux or Windows (tug.org/texlive), or tectonic (tectonic-typesetting.github.io). Then open this again.";

export const NO_TEX = `There’s no LaTeX on this computer. ${INSTALL_HINT}`;

export type Kind = "pdflatex" | "xelatex" | "lualatex" | "tectonic";
export const KINDS: readonly Kind[] = ["pdflatex", "xelatex", "lualatex", "tectonic"];

const NAMES: Record<Kind, string> = { pdflatex: "pdfLaTeX", xelatex: "XeLaTeX", lualatex: "LuaLaTeX", tectonic: "Tectonic" };

/** The engine's name for people. */
export function kindName(kind: Kind): string {
  return NAMES[kind];
}

/** The binary is the kind's own name. */
export function kindBin(kind: Kind): string {
  return kind;
}

export type Engine = { kind: Kind; path: string };

/**
 * The engine for `source`: pdfLaTeX for most documents, XeLaTeX or LuaLaTeX
 * when it loads system fonts, LuaLaTeX when it runs Lua; then whatever is installed.
 */
export function choose(engines: readonly Engine[], source: string): Engine | undefined {
  const has = (s: string) => source.includes(s);
  let order: Kind[];
  if (has("\\directlua") || has("{luacode")) order = ["lualatex", "tectonic"];
  else if (has("{fontspec}") || has("{unicode-math}") || has("{polyglossia}") || has("\\setmainfont")) order = ["xelatex", "lualatex", "tectonic"];
  else order = ["pdflatex", "xelatex", "lualatex", "tectonic"];
  for (const kind of [...order, ...KINDS]) {
    const found = engines.find((e) => e.kind === kind);
    if (found) return found;
  }
  return undefined;
}

/** Rust's `str::lines()`: splits on `\n`, drops one trailing `\r` per line, no final empty line. */
export function rustLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Whether `source` is a whole document rather than a figure's body. */
export function isDocument(source: string): boolean {
  return source.includes("\\documentclass");
}

const FIGURE_TAIL =
  "%\n}%\n\\ifdefined\\pdfpagewidth\\pdfpagewidth=\\dimexpr\\wd0+8pt\\relax\\pdfpageheight=\\dimexpr\\ht0+\\dp0+8pt\\relax" +
  "\\else\\pagewidth=\\dimexpr\\wd0+8pt\\relax\\pageheight=\\dimexpr\\ht0+\\dp0+8pt\\relax\\fi\n" +
  "\\hoffset=-1in \\voffset=-1in\n\\shipout\\vbox{\\kern4pt\\hbox{\\kern4pt\\box0\\kern4pt}\\kern4pt}\n\\end{document}\n";

/**
 * A figure's body as a document whose one page is the figure, cropped with a
 * small margin. Package lines move to the preamble and leave a blank line, so
 * line numbers still match. Returns the document and how many lines precede
 * the body's first line.
 */
export function figureDocument(body: string): { doc: string; before: number } {
  const preamble = [
    "\\documentclass{article}",
    "\\usepackage{amsmath,amssymb}",
    "\\usepackage{tikz}",
    "\\usetikzlibrary{arrows.meta,calc,positioning,decorations.pathreplacing,shapes.geometric,patterns,angles,quotes,backgrounds,fit}",
  ];
  if (["\\begin{axis}", "pgfplots", "\\addplot", "{semilogxaxis}", "{loglogaxis}", "{polaraxis}"].some((s) => body.includes(s))) {
    preamble.push("\\usepackage{pgfplots}\\pgfplotsset{compat=1.18}");
  }
  const lines: string[] = [];
  for (const line of rustLines(body)) {
    const t = line.trimStart();
    if (t.startsWith("\\usepackage") || t.startsWith("\\usetikzlibrary") || t.startsWith("\\usepgfplotslibrary") || t.startsWith("\\pgfplotsset")) {
      preamble.push(line);
      lines.push("");
    } else {
      lines.push(line);
    }
  }
  const joined = lines.join("\n");
  const wrapped = !joined.includes("\\begin{tikzpicture}");
  preamble.push("\\pagestyle{empty}", "\\begin{document}", "\\setbox0=\\hbox{%");
  if (wrapped) preamble.push("\\begin{tikzpicture}");
  const before = preamble.length;
  const doc = preamble.join("\n") + "\n" + joined + "\n" + (wrapped ? "\\end{tikzpicture}" : "") + FIGURE_TAIL;
  return { doc, before };
}

/** The first error in a TeX log in plain words, and its line in the source (`offset` lines before it are taken off). */
export function parseError(log: string, offset: number): { message: string; line: number | null } {
  const lines = rustLines(log);
  const at = lines.findIndex((l) => l.startsWith("! "));
  if (at < 0) {
    if (log.includes("No pages of output")) return { message: "The document has nothing to show: it made no pages.", line: null };
    return { message: "LaTeX couldn’t make a PDF of this document. The log says more.", line: null };
  }
  const raw = lines[at].slice(2).trim();
  let line: number | null = null;
  let context = "";
  for (const l of lines.slice(at + 1, at + 41)) {
    if (!l.startsWith("l.")) continue;
    const rest = l.slice(2);
    const digits = /^[0-9]*/.exec(rest)![0];
    if (digits === "") continue;
    const n = Number(digits);
    if (!Number.isSafeInteger(n) || n > 0xffffffff) continue;
    line = n > offset ? n - offset : null;
    context = rest.slice(digits.length).trim();
    break;
  }
  const atLine = line !== null ? ` (line ${line})` : "";
  const near = line !== null ? ` near line ${line}` : "";
  const filePrefix = "LaTeX Error: File `";
  if (raw.startsWith(filePrefix)) {
    const file = raw.slice(filePrefix.length).split("'")[0];
    if (file.endsWith(".sty") || file.endsWith(".cls")) {
      const stem = stripAll(stripAll(file, ".sty"), ".cls");
      return { message: `The LaTeX package “${stem}” isn’t installed on this computer${atLine}. With TeX Live or MacTeX, “tlmgr install ${stem}” adds it.`, line };
    }
    return { message: `The document asks for the file “${file}”${atLine}, which isn’t there: a document here compiles on its own, without other files.`, line };
  }
  if (raw.startsWith("Undefined control sequence")) {
    const last = context.split("\\").pop() ?? "";
    const cmd = /^[A-Za-z@]*/.exec(last)![0];
    if (cmd) return { message: `LaTeX doesn’t know the command \\${cmd}${atLine}. It may need a package the document doesn’t load, or be a typo.`, line };
    return { message: `LaTeX doesn’t know a command${atLine}. It may need a package the document doesn’t load, or be a typo.`, line };
  }
  if (raw.startsWith("Missing $ inserted")) return { message: `Something that only works in math (like ^, _ or \\alpha) is outside $…$${near}.`, line };
  if (raw.startsWith("I can't write on file") || raw.startsWith("I can’t write on file")) {
    return { message: "The document tried to write a file outside its own folder, which isn’t allowed here.", line };
  }
  if (raw.startsWith("Emergency stop") || raw.startsWith("==> Fatal error")) {
    return { message: `LaTeX stopped early${near}: the document ended before it was complete.`, line };
  }
  return { message: `LaTeX stopped${near}: ${raw.replace(/\.+$/, "")}.`, line };
}

/** Rust's `trim_end_matches`: removes every trailing repeat of `suffix`. */
function stripAll(s: string, suffix: string): string {
  while (suffix && s.endsWith(suffix)) s = s.slice(0, -suffix.length);
  return s;
}

/** Whether another run would settle references, contents or page counts (Rust precedence kept: the guard applies to the source branch only). */
export function needsRerun(log: string, source: string): boolean {
  return (
    log.includes("Rerun to get") ||
    log.includes("Label(s) may have changed") ||
    log.includes("Rerun LaTeX") ||
    (["\\tableofcontents", "\\listoffigures", "\\listoftables", "\\pageref", "LastPage"].some((s) => source.includes(s)) && !log.includes("(rerun not needed)"))
  );
}

/** The end of a log (where the error is), at most MAX_LOG bytes, starting on a character boundary. */
export function logTail(log: string): string {
  const bytes = Buffer.from(log, "utf8");
  if (bytes.length <= MAX_LOG) return log;
  let start = bytes.length - MAX_LOG;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return "…\n" + bytes.subarray(start).toString("utf8");
}

const MASK = (1n << 64n) - 1n;
const PRIME = 0x00000100000001b3n;

function rotl64(x: bigint, n: bigint): bigint {
  return ((x << n) | (x >> (64n - n))) & MASK;
}

/** A stable 128-bit hash (two FNV-1a lanes) as 32 hex digits, identical to the Rust core's, so its cache still hits. */
export function hashHex(parts: Uint8Array[]): string {
  let a = 0xcbf29ce484222325n;
  let b = 0x6c62272e07bb0142n;
  const step = (byte: number) => {
    a = ((a ^ BigInt(byte)) * PRIME) & MASK;
    b = rotl64(((b ^ BigInt(byte)) * PRIME) & MASK, 5n);
  };
  for (const part of parts) {
    for (const byte of part) step(byte);
    const len = Buffer.alloc(8);
    len.writeBigUInt64LE(BigInt(part.length));
    for (const byte of len) step(byte);
  }
  return a.toString(16).padStart(16, "0") + b.toString(16).padStart(16, "0");
}

export function cacheId(kind: Kind, figure: boolean, source: string): string {
  return hashHex([Buffer.from(kindBin(kind)), Buffer.from(figure ? "figure" : "document"), Buffer.from(source, "utf8")]);
}

/** Whether `id` could be a cache id, and so is safe as a file name. */
export function isCacheId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{32}$/.test(id);
}

/** A file name from a title: lowercase letters, digits and dashes, at most 60. */
export function slug(title: string, fallback: string): string {
  let s = "";
  for (const c of title.toLowerCase()) {
    if (/^[a-z0-9]$/.test(c)) s += c;
    else if (s !== "" && !s.endsWith("-")) s += "-";
    if (s.length >= 60) break;
  }
  s = s.replace(/^-+|-+$/g, "");
  return s === "" ? fallback : s;
}
