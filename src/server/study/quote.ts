import { byteLen, charLen, isAlnum, isAlpha, isLower, isUpper, isWs, rustLines, splitBy, splitWs } from "./text.ts";

/**
 * Finding a quoted passage in a course file, mechanically (Rust `study::quote`).
 * A quote must be in the file character for character, except for whitespace,
 * typographic quotes and dashes, ligatures, Markdown emphasis and a word
 * hyphenated across a line break. A quote may skip text with an ellipsis.
 *
 * Offsets here (`Found`, `at`) are JS string indices (UTF-16 code units) into
 * the original text, not UTF-8 byte offsets as in Rust.
 */

/** Shortest quote believed. */
export const MIN_CHARS = 12;
export const MIN_WORDS = 3;
/** Longest quote read. */
export const MAX_CHARS = 1_200;
/** Pieces of a quote cut with "…" must be this close together (compacted chars). */
export const GAP_MAX = 2_000;
/** Of a quote's words, the share that must be on a recognised page. */
export const ROUGH_SHARE = 0.6;
export const ROUGH_MIN_WORDS = 4;

function fold(c: string): string {
  switch (c) {
    case "‘":
    case "’":
    case "‚":
    case "‛":
    case "′":
    case "`":
    case "´":
      return "'";
    case "“":
    case "”":
    case "„":
    case "‟":
    case "″":
      return '"';
    case "‐":
    case "‑":
    case "‒":
    case "–":
    case "—":
    case "―":
    case "−":
      return "-";
    case "ﬀ":
      return "ff";
    case "ﬁ":
      return "fi";
    case "ﬂ":
      return "fl";
    case "ﬃ":
      return "ffi";
    case "ﬄ":
      return "ffl";
    case "­":
    case "​":
    case "‌":
    case "‍":
    case "﻿":
    case "*":
      return "";
    default:
      return c;
  }
}

/** Text without whitespace, folded, with each kept char's index in the original. */
export type Compact = { chars: string[]; at: number[] };

export function compact(text: string): Compact {
  const chars: string[] = [];
  const at: number[] = [];
  const cps: [number, string][] = [];
  for (let i = 0; i < text.length; ) {
    const c = String.fromCodePoint(text.codePointAt(i)!);
    cps.push([i, c]);
    i += c.length;
  }
  for (let k = 0; k < cps.length; k++) {
    const [i, c] = cps[k]!;
    if (isWs(c)) continue;
    if (c === "-" || c === "­" || c === "‐") {
      let j = k + 1;
      let sawSpace = false;
      while (j < cps.length && isWs(cps[j]![1])) {
        sawSpace = true;
        j++;
      }
      if (sawSpace && j < cps.length && isLower(cps[j]![1])) continue;
    }
    for (const f of fold(c)) {
      chars.push(f);
      at.push(i);
    }
  }
  return { chars, at };
}

function findFrom(hay: string[], needle: string[], from: number): number | null {
  if (!needle.length || needle.length > hay.length) return null;
  const first = needle[0];
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    if (hay[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return null;
}

/** Why a quote can't be checked at all, if it can't. */
export function unusable(quote: string): string | null {
  const q = stripMarks(quote);
  let kept = 0;
  for (const c of q) if (!isWs(c) && c !== "." && c !== "…") kept++;
  const words = splitWs(q).filter((w) => [...w].some(isAlnum)).length;
  if (charLen(q) > MAX_CHARS) return "is too long to be a quote";
  if (kept < MIN_CHARS || words < MIN_WORDS) return "is too short to check";
  return null;
}

/** The quote without wrapping quotation marks. */
export function stripMarks(quote: string): string {
  const t = rtrimWs(quote);
  for (const [open, close] of [
    ['"', '"'],
    ["“", "”"],
    ["'", "'"],
    ["‘", "’"],
  ] as const) {
    if (t.startsWith(open)) {
      const r = t.slice(open.length);
      if (r.endsWith(close)) return rtrimWs(r.slice(0, r.length - close.length));
    }
  }
  return t;
}

function rtrimWs(s: string): string {
  const cs = [...s];
  let a = 0;
  let b = cs.length;
  while (a < b && isWs(cs[a]!)) a++;
  while (b > a && isWs(cs[b - 1]!)) b--;
  return cs.slice(a, b).join("");
}

/** A quote as kept and shown: no wrapping marks, no `**`, whitespace squeezed. */
export function tidy(quote: string): string {
  return splitWs(stripMarks(quote).replaceAll("**", "")).join(" ");
}

function pieces(quote: string): string[] {
  let q = stripMarks(quote);
  for (const e of ["[…]", "[...]", "(…)", "(...)", ". . .", "…"]) q = q.replaceAll(e, "\u0000");
  q = q.replaceAll("...", "\u0000");
  return q
    .split("\u0000")
    .map(rtrimWs)
    .filter((p) => [...p].filter((c) => !isWs(c)).length >= 4);
}

/** A match: [start, end) as JS string indices in the original text. */
export type Found = { start: number; end: number };

export function findIn(text: string, hay: Compact, quote: string): Found | null {
  if (unusable(quote) !== null) return null;
  const parts = pieces(quote);
  if (!parts.length) return null;
  const first = compact(parts[0]!).chars;
  let from = 0;
  for (;;) {
    const start = findFrom(hay.chars, first, from);
    if (start === null) return null;
    let end = start + first.length;
    let ok = true;
    for (const p of parts.slice(1)) {
      const needle = compact(p).chars;
      const i = findFrom(hay.chars, needle, end);
      if (i !== null && i - end <= GAP_MAX) end = i + needle.length;
      else {
        ok = false;
        break;
      }
    }
    if (ok) {
      const lastAt = hay.at[end - 1]!;
      const ch = String.fromCodePoint(text.codePointAt(lastAt) ?? 0);
      return { start: hay.at[start]!, end: lastAt + Math.max(ch.length, 1) };
    }
    from = start + 1;
  }
}

export function find(text: string, quote: string): Found | null {
  return findIn(text, compact(text), quote);
}

/** The passage around a match: up to `around` chars each side, cut at words, whitespace squeezed. */
export function context(text: string, f: Found, around: number): [string, string, string] {
  const squeeze = (s: string) => splitWs(s).join(" ");
  const beforeFull = text.slice(0, f.start);
  const afterFull = text.slice(f.end);
  const bcs = [...beforeFull];
  let before = bcs.slice(Math.max(bcs.length - around, 0)).join("");
  if (before.length < beforeFull.length) {
    const sp = [...before].findIndex(isWs);
    if (sp >= 0) before = "…" + [...before].slice(sp).join("");
  }
  const acs = [...afterFull];
  let after = acs.slice(0, around).join("");
  if (after.length < afterFull.length) {
    const ac = [...after];
    let sp = -1;
    for (let i = ac.length - 1; i >= 0; i--)
      if (isWs(ac[i]!)) {
        sp = i;
        break;
      }
    if (sp >= 0) after = ac.slice(0, sp).join("") + "…";
  }
  const lastB = [...before].pop();
  const firstA = [...after][0];
  const lead = lastB !== undefined && isWs(lastB) ? " " : "";
  const trail = firstA !== undefined && isWs(firstA) ? " " : "";
  return [
    rtrimStartWs(squeeze(before) + lead),
    squeeze(text.slice(f.start, f.end)),
    rtrimEndWs(trail + squeeze(after)),
  ];
}

function rtrimStartWs(s: string): string {
  const cs = [...s];
  let a = 0;
  while (a < cs.length && isWs(cs[a]!)) a++;
  return cs.slice(a).join("");
}
function rtrimEndWs(s: string): string {
  const cs = [...s];
  let b = cs.length;
  while (b > 0 && isWs(cs[b - 1]!)) b--;
  return cs.slice(0, b).join("");
}

function roughWords(s: string): string[] {
  return splitBy(s, (c) => !isAlnum(c))
    .filter((w) => charLen(w) >= 3)
    .map((w) => w.toLowerCase());
}

/** Whether `a` and `b` differ by at most `max` single-character edits. */
export function near(a0: string, b0: string, max: number): boolean {
  const a = [...a0];
  const b = [...b0];
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(i + 1);
    for (let j = 0; j < b.length; j++) {
      cur[j + 1] = Math.min(prev[j]! + (a[i] !== b[j] ? 1 : 0), prev[j + 1]! + 1, cur[j]! + 1);
    }
    if (Math.min(...cur) > max) return false;
    prev = cur;
  }
  return prev[b.length]! <= max;
}

/** Whether a quote read from a page's picture roughly matches its recognised text. */
export function roughly(page: string, quote: string): boolean {
  if (charLen(stripMarks(quote)) > MAX_CHARS) return false;
  const want = roughWords(stripMarks(quote));
  if (want.length < ROUGH_MIN_WORDS) return false;
  const have = new Set(roughWords(page));
  let found = 0;
  for (const w of want) {
    if (have.has(w)) {
      found++;
      continue;
    }
    const n = charLen(w);
    const max = n >= 8 ? 2 : n >= 5 ? 1 : 0;
    if (max > 0 && [...have].some((h) => near(w, h, max))) found++;
  }
  return found >= ROUGH_SHARE * want.length;
}

function leadingDigits(s: string): string {
  const m = /^[0-9]*/.exec(s);
  return m ? m[0] : "";
}

function parseU32(s: string): number | null {
  if (!/^[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return n <= 0xffffffff ? n : null;
}

/** The text under "## Page N" in a text copy, up to the next page. */
export function pageText(copy: string, n: number): string | null {
  let out: string | null = null;
  for (const line of rustLines(copy)) {
    if (line.startsWith("## Page ")) {
      if (out !== null) break;
      if (parseU32(leadingDigits(line.slice(8))) === n) out = "";
      continue;
    }
    if (out !== null) out += line + "\n";
  }
  return out === null ? null : out.trim();
}

/** The page of a text copy an index is on (its last "## Page N" before it). */
export function pageAt(copy: string, at: number): number | null {
  const head = copy.slice(0, Math.min(at, copy.length));
  const i = head.lastIndexOf("## Page ");
  if (i < 0) return null;
  return parseU32(leadingDigits(head.slice(i + 8)));
}

const isAsciiDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isAsciiAlnum = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9]$/.test(c);

/** The last 12,000 UTF-8 bytes of `head`, started on a whole character. */
function windowOf(head: string): string {
  let bytes = 0;
  let i = head.length;
  while (i > 0) {
    let start = i - 1;
    const code = head.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff && start > 0) start--;
    const b = byteLen(head.slice(start, i));
    if (bytes + b > 12_000) break;
    bytes += b;
    i = start;
  }
  return head.slice(i);
}

/** Where a passage is: the nearest numbered section before it ("§5.3") or, on a problem set, the problem ("#3"). */
export function locate(text: string, at: number, problemSet: boolean): string | null {
  const head = text.slice(0, Math.min(at, text.length));
  const window = windowOf(head);
  if (problemSet) {
    let last: string | null = null;
    for (const line of rustLines(window)) {
      const t = line.trim();
      const num = leadingDigits(t);
      if (num && num.length <= 2 && t.slice(num.length).startsWith(".")) {
        const next = [...t.slice(num.length + 1)][0];
        if (next === undefined || isWs(next)) last = num;
      }
    }
    return last === null ? null : `#${last}`;
  }
  let best: string | null = null;
  let i = 0;
  while (i < window.length) {
    if (isAsciiDigit(window[i]) && (i === 0 || !(isAsciiAlnum(window[i - 1]) || window[i - 1] === "."))) {
      let j = i;
      let dots = 0;
      while (j < window.length && (isAsciiDigit(window[j]) || (window[j] === "." && j + 1 < window.length && isAsciiDigit(window[j + 1])))) {
        if (window[j] === ".") dots++;
        j++;
      }
      const rest = window.slice(j);
      let k = 0;
      while (rest[k] === " ") k++;
      const nextWord = rest.slice(k);
      const spaced = k > 0 && k <= 2;
      const firstCh = [...nextWord][0];
      if (dots >= 1 && dots <= 3 && j - i <= 8 && spaced && firstCh !== undefined && isUpper(firstCh)) {
        const w = splitWs(nextWord)[0];
        if (w !== undefined && charLen(w) >= 3 && [...w].every((c) => isAlpha(c) || c === "-")) best = `§${window.slice(i, j)}`;
      }
      i = Math.max(j, i + 1);
    } else i++;
  }
  return best;
}
