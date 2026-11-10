/**
 * Math in replies: remark-math finds $…$ and $$…$$, rehype-katex draws it.
 * Models write \(…\) and \[…\] too, and dollars that mean money; this turns
 * the text into what remark-math reads as the writer meant, never touching
 * code. Pure, so it is unit-tested.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Applies `fn` to the prose of `text`: everything outside fenced blocks and
 * inline code spans. Fence lines and code are kept exactly.
 */
export function mapProse(text: string, fn: (prose: string) => string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) out.push(mapInline(prose.join("\n"), fn));
    prose = [];
  };
  for (const line of text.split("\n")) {
    const open = FENCE.exec(line);
    if (fence) {
      out.push(line);
      if (open && line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, "") === "") fence = null;
      continue;
    }
    if (open) {
      flush();
      fence = open[1];
      out.push(line);
      continue;
    }
    prose.push(line);
  }
  flush();
  return out.join("\n");
}

function mapInline(text: string, fn: (prose: string) => string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const tick = text.indexOf("`", i);
    const end = tick < 0 ? text.length : tick;
    out += fn(text.slice(i, end));
    if (tick < 0) break;
    const run = /^`+/.exec(text.slice(tick))![0];
    const close = text.indexOf(run, tick + run.length);
    if (close < 0) {
      out += text.slice(tick);
      break;
    }
    out += text.slice(tick, close + run.length);
    i = close + run.length;
  }
  return out;
}

/** \(…\) → $…$ and \[…\] → $$…$$ (display, on lines of its own). */
export function normalizeMathDelimiters(prose: string): string {
  return prose
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, inner: string) => `\n$$\n${inner.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, inner: string) => `$${inner.trim()}$`);
}

/**
 * A dollar that starts an amount of money ($5, $10.50, $3,000, $2k) is
 * escaped, so "$5 and $10" stays text. `$2x$` and `$2$` stay math.
 */
export function escapeCurrencyDollars(prose: string): string {
  return prose.replace(/(^|[^\\$])\$(?=\d[\d,]*(?:\.\d+)?(?:[kKmMbB]\b)?(?:\s|$|[.,;:!?)\]—–-]))/g, "$1\\$");
}

/**
 * A line that is only `$$…$$` is display math, as its writer meant;
 * remark-math would read it as inline math in a paragraph.
 */
function displayLines(prose: string): string {
  return prose
    .split("\n")
    .map((line) => {
      const m = /^(\s{0,3})\$\$(?!\$)(.+?)(?<!\\)\$\$\s*$/.exec(line);
      return m && !m[2].includes("$$") ? `${m[1]}$$\n${m[1]}${m[2].trim()}\n${m[1]}$$` : line;
    })
    .join("\n");
}

/**
 * The text ready for remark-math. A `$$` block left open is held back while
 * the reply is still `streaming` (nothing half-drawn flashes); once the
 * reply is done it shows as written.
 */
export function prepareMath(text: string, streaming = false): string {
  if (!text.includes("$") && !text.includes("\\(") && !text.includes("\\[")) return text;
  const t = mapProse(text, (p) => displayLines(escapeCurrencyDollars(normalizeMathDelimiters(p))));
  let inFence: string | null = null;
  let open = -1;
  let offset = 0;
  for (const line of t.split("\n")) {
    const f = FENCE.exec(line);
    if (f) {
      if (!inFence) inFence = f[1][0];
      else if (f[1][0] === inFence) inFence = null;
    } else if (!inFence) {
      const bare = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
      for (let i = bare.indexOf("$$"); i !== -1; i = bare.indexOf("$$", i + 2)) {
        if (i > 0 && bare[i - 1] === "\\") continue;
        open = open === -1 ? offset + i : -1;
      }
    }
    offset += line.length + 1;
  }
  if (open === -1) return t;
  return streaming ? t.slice(0, open).trimEnd() : `${t.slice(0, open)}\\$\\$${t.slice(open + 2)}`;
}
