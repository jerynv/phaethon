// Math in markdown: remark-math finds $…$ and $$…$$, rehype-katex draws it
// with KaTeX (MIT), keeping its MathML beside the drawing so screen readers
// read the formula. KaTeX's fonts are bundled (CSP font-src is 'self').
import "katex/dist/katex.min.css";
import "./rich.css";

import { escapeCurrencyDollars, normalizeMathDelimiters } from "@assistant-ui/react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import type { Options } from "react-markdown";

type PluggableList = NonNullable<Options["remarkPlugins"]>;

/**
 * KaTeX as Phaethon uses it: a formula it can't read shows its source (in
 * the danger ink, with the reason as its tooltip) instead of throwing; no
 * \href or \includegraphics; bounded macro expansion and sizes, so a
 * pathological formula can't hang the page.
 */
const KATEX = {
  throwOnError: false,
  errorColor: "var(--ph-danger-ink)",
  strict: "ignore",
  trust: false,
  output: "htmlAndMathml",
  maxExpand: 500,
  maxSize: 40,
} as const;

/** Wide display math gets a box of its own that scrolls sideways and takes focus. */
type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };
function rehypeMathBoxes() {
  const isDisplay = (n: HastNode) => {
    const c = n.properties?.className;
    return Array.isArray(c) && c.includes("katex-display");
  };
  const walk = (n: HastNode) => {
    for (const child of n.children ?? []) {
      if (child.type === "element" && isDisplay(child)) {
        child.properties = { ...child.properties, tabIndex: 0, role: "group", ariaLabel: "Formula", dataMathDisplay: "" };
      } else walk(child);
    }
  };
  return (tree: HastNode) => walk(tree);
}

export const MATH_REMARK: PluggableList = [remarkMath];
export const MATH_REHYPE: PluggableList = [[rehypeKatex, KATEX], rehypeMathBoxes];

/** Fence lines (``` or ~~~), so `$$` inside code is never counted or touched. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A line that is only `$$…$$` (as \[…\] on one line becomes) is display
 * math, as its writer meant; remark-math would read it as inline math in a
 * paragraph. It is written as a block, outside code only.
 */
function displayLines(text: string): string {
  let inFence: string | null = null;
  return text
    .split("\n")
    .map((line) => {
      const f = FENCE.exec(line);
      if (f) {
        if (!inFence) inFence = f[1][0];
        else if (f[1][0] === inFence) inFence = null;
        return line;
      }
      const m = inFence ? null : /^(\s{0,3})\$\$(?!\$)(.+?)(?<!\\)\$\$\s*$/.exec(line);
      return m && !m[2].includes("$$") ? `${m[1]}$$\n${m[1]}${m[2].trim()}\n${m[1]}$$` : line;
    })
    .join("\n");
}

/**
 * The text with model-style delimiters made into dollars: \(…\) and \[…\]
 * become $…$ and $$…$$ (never inside code), and a dollar that starts an
 * amount of money ($5) stays a dollar. Then a $$ block left open: while the
 * reply is still `streaming` it is held back (nothing half-drawn flashes);
 * once the reply is done it shows as written.
 */
export function prepareMath(text: string, streaming = false): string {
  const t = displayLines(escapeCurrencyDollars(normalizeMathDelimiters(text)));
  // Find a $$ that is opened and never closed, outside code.
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
