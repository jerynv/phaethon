import fs from "node:fs";
import path from "node:path";
import { Refusal } from "../../rpc/registry.ts";
import { byteLength } from "../../core/fsx.ts";

/**
 * `search_files`: one word matches literal lines; several words match a window
 * of nearby lines (with its heading) that contains all of them, ranked by
 * relevance. Every scan is bounded, and the output says when a bound was hit.
 * The output format is model-facing; keep it exact.
 */

export const MAX_HITS = 200;
export const MAX_SEARCH_FILE = 2 * 1024 * 1024;
export const MAX_SEARCH_FILES = 2000;
export const MAX_SEARCH_ENTRIES = 20_000;
export const MAX_SEARCH_WINDOWS = 100_000;
export const MAX_SEARCH_BYTES = 32 * 1024 * 1024;
export const MAX_SEARCH_OUTPUT = 128 * 1024;
export const SEARCH_WINDOW_LINES = 8;
export const SEARCH_TIMEOUT_MS = 3000;

/** Cuts to at most `n` UTF-8 bytes on a character boundary, ending with "…". */
export function excerpt(text: string, n: number): string {
  if (byteLength(text) <= n) return text;
  const budget = n - 3;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const b = byteLength(ch);
    if (used + b > budget) break;
    out += ch;
    used += b;
  }
  return out + "…";
}

export type Query = { phrase: string; multi: boolean; terms: string[]; original: string };

export function parseQuery(raw: string): Query {
  const trimmed = raw.trim();
  if (!trimmed) throw new Refusal("query must not be empty");
  if (byteLength(raw) > 2048) throw new Refusal("query is too long; use at most 2048 bytes and narrow the folder.");
  const phrase = trimmed.split(/\s+/).join(" ").toLowerCase();
  const multi = phrase.includes(" ");
  const terms = multi ? [...new Set(phrase.split(/[^\p{L}\p{N}_]+/u).filter(Boolean))].sort() : [phrase];
  if (terms.length < 1 || terms.length > 16) throw new Refusal("Use between 1 and 16 search terms.");
  return { phrase, multi, terms, original: raw };
}

/** A tree to search: files are re-checked by `allow` before reading (courses). */
export type Root = { dir: string; prefix: string; skipRootCourses?: boolean; allow?: (rel: string) => string | undefined; filter?: (rel: string, text: string) => string };

type Hit = { path: string; line: number; score: number; text: string };

class Budget {
  started = Date.now();
  files = 0;
  bytes = 0;
  windows = 0;
  entries = 0;
  notes = new Set<string>();
  stopped = false;
}

function isHeading(trimmedStart: string): boolean {
  return /^#{1,6}[ \t\n\f\r\v]/.test(trimmedStart);
}

const popcount = (n: number) => {
  let c = 0;
  while (n) {
    c += n & 1;
    n >>>= 1;
  }
  return c;
};

function maskOf(text: string, terms: string[]): number {
  let m = 0;
  terms.forEach((t, i) => {
    if (text.includes(t)) m |= 1 << i;
  });
  return m;
}

function occurrences(text: string, term: string): number {
  if (!term) return 0;
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(term, i)) >= 0 && n < 10) {
    n++;
    i += term.length;
  }
  return n;
}

function scanText(rel: string, text: string, q: Query, budget: Budget, hits: Hit[]): void {
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const all = (1 << q.terms.length) - 1;
  let fenced = false;
  let heading: string | undefined;
  let headingMask = 0;
  const headingAt: boolean[] = [];
  // First pass: which lines are headings (outside code fences).
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("```") || t.startsWith("~~~")) {
      fenced = !fenced;
      headingAt.push(false);
      continue;
    }
    headingAt.push(!fenced && isHeading(line.trimStart()));
  }
  for (let i = 0; i < lines.length; i++) {
    if (budget.windows >= MAX_SEARCH_WINDOWS) {
      budget.notes.add("100,000-line/window scan budget");
      budget.stopped = true;
      return;
    }
    budget.windows++;
    const line = lines[i];
    const lower = line.toLowerCase();
    if (headingAt[i]) {
      heading = line.trim();
      headingMask = maskOf(lower, q.terms);
    }
    if (!q.multi) {
      if (!lower.includes(q.phrase)) continue;
      const score = 10000 + popcount(headingMask) * 100 + (headingAt[i] ? 100 : 0);
      hits.push({ path: rel, line: i + 1, score, text: excerpt(line.trim(), 600) });
      continue;
    }
    if (!q.terms.some((t) => lower.includes(t))) continue;
    const body: string[] = [];
    for (let j = i; j < lines.length && j < i + SEARCH_WINDOW_LINES; j++) {
      if (j > i && headingAt[j]) break;
      const t = lines[j].trim();
      if (t) body.push(t);
    }
    const joined = body.join(" ").toLowerCase();
    if ((maskOf(joined, q.terms) | headingMask) !== all) continue;
    const phraseHit = joined.split(/\s+/).join(" ").includes(q.phrase);
    const frequency = q.terms.reduce((n, t) => n + occurrences(joined, t), 0);
    const score = (phraseHit ? 10000 : 0) + popcount(headingMask) * 100 + frequency;
    let shown = body.join(" | ");
    if (heading && !headingAt[i]) shown = `[${excerpt(heading.replace(/^#+/, "").trim(), 120)}] ${shown}`;
    hits.push({ path: rel, line: i + 1, score, text: excerpt(shown, 600) });
  }
}

function walk(root: Root, q: Query, budget: Budget, hits: Hit[]): void {
  // Depth first; children sorted by path and pushed in reverse so they pop in ascending order.
  type Entry = { abs: string; rel: string; depth: number; dir: boolean };
  const stack: Entry[] = [{ abs: root.dir, rel: "", depth: 0, dir: true }];
  while (stack.length && !budget.stopped) {
    const entry = stack.pop()!;
    if (!entry.dir) {
      scanFile(root, entry.abs, entry.rel, q, budget, hits);
      continue;
    }
    let names: string[];
    try {
      names = fs.readdirSync(entry.abs);
    } catch {
      continue;
    }
    const children: Entry[] = [];
    for (const name of names) {
      if (budget.entries >= MAX_SEARCH_ENTRIES) {
        budget.notes.add("20,000-entry discovery budget");
        break;
      }
      budget.entries++;
      const abs = path.join(entry.abs, name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (root.allow && name.startsWith(".")) continue;
      const rel = entry.rel ? `${entry.rel}/${name}` : name;
      if (st.isDirectory()) {
        if (name === ".phaethon") continue;
        if (entry.depth === 0 && root.skipRootCourses && name.toLowerCase() === "courses") continue;
        children.push({ abs, rel, depth: entry.depth + 1, dir: true });
      } else if (st.isFile() && st.size <= MAX_SEARCH_FILE) {
        children.push({ abs, rel, depth: entry.depth + 1, dir: false });
      }
    }
    children.sort((a, b) => (a.abs < b.abs ? -1 : a.abs > b.abs ? 1 : 0));
    for (const c of children.reverse()) stack.push(c);
  }
}

function scanFile(root: Root, abs: string, rel: string, q: Query, budget: Budget, hits: Hit[]): void {
  if (Date.now() - budget.started > SEARCH_TIMEOUT_MS) {
    budget.notes.add("3-second scan budget");
    budget.stopped = true;
    return;
  }
  if (budget.files >= MAX_SEARCH_FILES) {
    budget.notes.add("2,000-file scan budget");
    budget.stopped = true;
    return;
  }
  let real = abs;
  if (root.allow) {
    const checked = root.allow(rel);
    if (!checked) return;
    real = checked;
  }
  let size: number;
  try {
    size = fs.statSync(real).size;
  } catch {
    return;
  }
  const remaining = MAX_SEARCH_BYTES - budget.bytes;
  if (Math.min(size, MAX_SEARCH_FILE + 1) > remaining) {
    budget.notes.add("32 MiB text scan budget");
    budget.stopped = true;
    return;
  }
  budget.files++;
  let buf: Buffer;
  try {
    const fd = fs.openSync(real, "r");
    try {
      const want = Math.min(MAX_SEARCH_FILE + 1, remaining + 1, size);
      buf = Buffer.alloc(want);
      const n = fs.readSync(fd, buf, 0, want, 0);
      buf = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }
  budget.bytes += buf.length;
  if (buf.includes(0)) return;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return;
  }
  if (root.filter) text = root.filter(rel, text);
  scanText(`${root.prefix}${rel}`, text, q, budget, hits);
}

/** Runs a search over the given trees and formats the model-facing result. */
export function search(roots: Root[], rawQuery: string): string {
  const q = parseQuery(rawQuery);
  const budget = new Budget();
  const hits: Hit[] = [];
  for (const root of roots) {
    if (budget.stopped) break;
    walk(root, q, budget, hits);
  }
  hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line);
  const total = hits.length;
  const best = hits.slice(0, MAX_HITS);
  let out = "";
  let shown = 0;
  for (const h of best) {
    const row = `${h.path}:${h.line}: ${h.text}`;
    if (byteLength(out) + byteLength(row) + 1 > MAX_SEARCH_OUTPUT - 1024) {
      budget.notes.add("128 KiB output budget");
      break;
    }
    out += (out ? "\n" : "") + row;
    shown++;
  }
  if (!shown) out = `No lines contain “${q.original}”.`;
  if (total > shown) out += `\nShowing ${shown} of ${total} matching ${q.multi ? "chunks" : "lines"} in scanned content.`;
  if (budget.notes.size) {
    out += `\nSearch is partial: ${[...budget.notes].sort().join(", ")} reached after ${budget.files} files and ${budget.windows} lines/windows. Narrow the path or query to continue.`;
  }
  return out;
}
