import { context, find, locate, pageAt, unusable } from "./quote.ts";
import { readCited, type Cited } from "./sources.ts";
import { baseName, stripSuffixAll, trimChars } from "./text.ts";
import type { Visible } from "./visible.ts";

/**
 * Citations in a chat reply, checked when the reply is shown (Rust
 * `study::citations`): is each quote really in that file, as this space may
 * read it.
 */

/** Most citations checked in one call. */
export const MAX = 60;
const AROUND = 400;

export type Asked = { path: string; quote: string };

/** What a citation turned out to be (empty strings and unset options are omitted). */
export type Checked = {
  found: boolean;
  path: string;
  name: string;
  at?: string;
  page?: number;
  before?: string;
  passage?: string;
  after?: string;
  why?: string;
};

function nameOf(p: string): string {
  return baseName(stripSuffixAll(p, "/"));
}

function miss(why: string, path: string): Checked {
  return { found: false, path, name: nameOf(path), why };
}

/** Checks each citation against its file. Never fails as a whole. Past MAX, each says it wasn't checked. */
export function check(space: string, visible: Visible, asked: Asked[]): Checked[] {
  const read = new Map<string, { ok: Cited } | { err: string }>();
  return asked.map((a, i) => {
    const path = trimChars(String(a.path ?? "").trim(), "\"'`");
    if (i >= MAX) return miss(`Not checked: only the first ${MAX} citations in a reply are checked.`, path);
    const quote = String(a.quote ?? "");
    const why = unusable(quote);
    if (why !== null) return miss(`The quote ${why}.`, path);
    let doc = read.get(path);
    if (!doc) {
      try {
        doc = { ok: readCited(space, visible, path) };
      } catch (e) {
        doc = { err: String(e) };
      }
      read.set(path, doc);
    }
    if (!("ok" in doc)) return miss("That isn’t a file in your materials that this space can read.", path);
    const { label, text } = doc.ok;
    const f = find(text, quote);
    if (!f) return miss("Those words aren’t in that file.", label);
    const name = nameOf(label);
    const low = name.toLowerCase();
    const problemSet = low.startsWith("hw") || low.includes("homework") || low.includes("review") || low.includes("problem set");
    const [before, passage, after] = context(text, f, AROUND);
    const p = low.endsWith(".pdf") ? pageAt(text, f.start) : null;
    const page = p !== null && p > 0 ? p : null;
    const at = locate(text, f.start, problemSet) ?? (page !== null ? `p. ${page}` : null);
    const out: Checked = { found: true, path: label, name };
    if (at !== null) out.at = at;
    if (page !== null) out.page = page;
    if (before) out.before = before;
    if (passage) out.passage = passage;
    if (after) out.after = after;
    return out;
  });
}
