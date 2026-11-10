import type { UiMessage } from "#shared/agent.ts";
import { listThreadsIn, loadConversationIn, toUi } from "../threads/store.ts";

/**
 * Search the text of saved conversations: only what the conversation view
 * shows (`toUi` text), never thinking, tool calls or tool results. Matching
 * ignores case and accents and treats any run of whitespace as one space.
 * Results never go to the model; there is no index.
 */

export const MAX_CONVERSATIONS = 50;
export const MAX_SNIPPETS = 3;
export const MAX_QUERY_CHARS = 200;
const BEFORE = 48;
const AFTER = 96;

export type Snippet = { message: number; role: "user" | "assistant"; before: string; matched: string; after: string };
export type Conversation = {
  space: string;
  threadId: string;
  title: string;
  updated: number;
  current: boolean;
  matches: number;
  snippets: Snippet[];
};
export type Results = { conversations: Conversation[]; truncated: boolean };

/** Folded characters, each with its span (UTF-16 offsets) in the original text. */
type Folded = { chars: string[]; spans: [number, number][] };

const ACCENTED: [string, string][] = [
  ["àáâãäåāăąǎ", "a"],
  ["çćĉċč", "c"],
  ["ďđ", "d"],
  ["èéêëēĕėęě", "e"],
  ["ĝğġģ", "g"],
  ["ĥħ", "h"],
  ["ìíîïĩīĭįı", "i"],
  ["ĵ", "j"],
  ["ķ", "k"],
  ["ĺļľŀł", "l"],
  ["ñńņňŉ", "n"],
  ["òóôõöøōŏőǒ", "o"],
  ["ŕŗř", "r"],
  ["śŝşšș", "s"],
  ["ţťŧț", "t"],
  ["ùúûüũūŭůűųǔ", "u"],
  ["ŵ", "w"],
  ["ýÿŷ", "y"],
  ["źżž", "z"],
  ["æ", "ae"],
  ["œ", "oe"],
  ["ß", "ss"],
];
const BASE = new Map<string, string>();
for (const [set, base] of ACCENTED) for (const c of set) BASE.set(c, base);

const WHITE = /^\p{White_Space}$/u;

function isCombining(c: string): boolean {
  const cp = c.codePointAt(0)!;
  return cp >= 0x300 && cp <= 0x36f;
}

export function fold(text: string): Folded {
  const out: Folded = { chars: [], spans: [] };
  let gap = true;
  let i = 0;
  for (const c of text) {
    const start = i;
    const end = i + c.length;
    i = end;
    if (WHITE.test(c)) {
      if (!gap) {
        out.chars.push(" ");
        out.spans.push([start, end]);
        gap = true;
      }
      continue;
    }
    if (isCombining(c)) {
      const last = out.spans[out.spans.length - 1];
      if (last) last[1] = end;
      continue;
    }
    gap = false;
    // Per code point, so no context rule (final sigma) applies.
    for (const l of c.toLowerCase()) {
      const base = l.charCodeAt(0) < 0x80 ? undefined : BASE.get(l);
      for (const b of base ?? l) {
        out.chars.push(b);
        out.spans.push([start, end]);
      }
    }
  }
  if (out.chars[out.chars.length - 1] === " ") {
    out.chars.pop();
    out.spans.pop();
  }
  return out;
}

export function foldQuery(query: string): string[] {
  return fold([...query].slice(0, MAX_QUERY_CHARS).join("")).chars;
}

/** Non-overlapping matches, left to right. */
export function findAll(hay: string[], needle: string[]): [number, number][] {
  const out: [number, number][] = [];
  if (!needle.length || needle.length > hay.length) return out;
  let i = 0;
  while (i + needle.length <= hay.length) {
    let hit = true;
    for (let k = 0; k < needle.length; k++) {
      if (hay[i + k] !== needle[k]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      out.push([i, i + needle.length]);
      i += needle.length;
    } else i++;
  }
  return out;
}

function squash(s: string): string {
  let out = "";
  let gap = false;
  for (const c of s) {
    if (WHITE.test(c)) gap = true;
    else {
      if (gap && out) out += " ";
      gap = false;
      out += c;
    }
  }
  if (gap && out) out += " ";
  return out;
}

export function snippet(text: string, start: number, end: number, message: number, role: "user" | "assistant"): Snippet {
  const head = [...text.slice(0, start)];
  const tail = [...text.slice(end)];
  const before = head.length > BEFORE ? `…${head.slice(head.length - BEFORE).join("").replace(/^\p{White_Space}+/u, "")}` : head.join("");
  const after = tail.length > AFTER ? `${tail.slice(0, AFTER).join("").replace(/\p{White_Space}+$/u, "")}…` : tail.join("");
  return {
    message,
    role,
    before: squash(before).replace(/^\p{White_Space}+/u, ""),
    matched: squash(text.slice(start, end)),
    after: squash(after).replace(/\p{White_Space}+$/u, ""),
  };
}

function searchMessages(msgs: UiMessage[], needle: string[]): { matches: number; snippets: Snippet[] } | null {
  let matches = 0;
  const snippets: Snippet[] = [];
  msgs.forEach((m, pos) => {
    const f = fold(m.text);
    for (const [a, b] of findAll(f.chars, needle)) {
      matches++;
      if (snippets.length < MAX_SNIPPETS) snippets.push(snippet(m.text, f.spans[a]![0], f.spans[b - 1]![1], pos, m.role));
    }
  });
  return matches ? { matches, snippets } : null;
}

/** Searches the current and archived conversations of each `(space id, folder)`. */
export function search(spaces: [string, string][], query: string): Results {
  const needle = foldQuery(query);
  const found: Conversation[] = [];
  if (!needle.length) return { conversations: found, truncated: false };
  for (const [space, dir] of spaces) {
    let list;
    try {
      list = listThreadsIn(dir);
    } catch {
      continue;
    }
    for (const t of list) {
      let msgs;
      try {
        msgs = loadConversationIn(dir, t.id);
      } catch {
        continue;
      }
      const hit = searchMessages(toUi(msgs), needle);
      if (hit) found.push({ space, threadId: t.id, title: t.title, updated: t.updated, current: t.current, ...hit });
    }
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  found.sort((a, b) => b.updated - a.updated || cmp(a.space, b.space) || cmp(b.threadId, a.threadId));
  const truncated = found.length > MAX_CONVERSATIONS;
  return { conversations: found.slice(0, MAX_CONVERSATIONS), truncated };
}
