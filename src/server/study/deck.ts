import type { Deck, Note } from "./types.ts";
import { asciiLower, charLen, fnvParts, rtrim, rtrimEnd, rtrimStart, rustLines, squeeze } from "./text.ts";

/**
 * Flashcard decks as Markdown, readable and editable by hand (port of
 * `study/deck.rs`). Parsing never fails; `write` gives the canonical form
 * `parse` reads back exactly.
 */

export const FRONT_MAX = 2_000;
export const BACK_MAX = 4_000;
export const TITLE_MAX = 120;
/** Cards one deck file may hold (generation caps far lower). */
export const DECK_CARDS_MAX = 2_000;

/** The end of a `From:` line for a passage read from a page's picture. */
export const PICTURE_MARK = ", read from a picture of the page)";

export type Kind = "basic" | "cloze";

export function emptyDeck(): Deck {
  return { title: "", sources: [], extra: [], preamble: "", notes: [] };
}

/** `notes.pdf (p. 3, read from a picture of the page)` → [`notes.pdf`, 3]. */
export function splitPicture(from: string): [string, number] | null {
  if (!from.endsWith(PICTURE_MARK)) return null;
  const inner = from.slice(0, from.length - PICTURE_MARK.length);
  const i = inner.lastIndexOf(" (p. ");
  if (i < 0) return null;
  const path = inner.slice(0, i);
  const pageText = rtrim(inner.slice(i + 5));
  if (!/^\+?[0-9]+$/.test(pageText)) return null;
  const page = Number(pageText.replace(/^\+/, ""));
  if (!(page > 0) || page > 0xffffffff) return null;
  if (rtrim(path) === "") return null;
  return [rtrimEnd(path), page];
}

export function kindOf(note: Note | string): Kind {
  const front = typeof note === "string" ? note : note.front;
  return front.includes("{{") ? "cloze" : "basic";
}

/** `c1::text::hint` (Anki) → `text`; anything else as is (trimmed). */
function clozeText(inner: string): string {
  let s = inner;
  const i = s.indexOf("::");
  if (i >= 0) {
    const tag = s.slice(0, i);
    if (Buffer.byteLength(tag) <= 4 && (tag.startsWith("c") || tag.startsWith("C")) && /^[0-9]*$/.test(tag.slice(1))) s = s.slice(i + 2);
  }
  return rtrim(s.split("::")[0] ?? s);
}

/** The text hidden by each `{{...}}` in `front`, in order. Throws on an unclosed or empty blank. */
export function clozeAnswers(front: string): string[] {
  const out: string[] = [];
  let rest = front;
  for (;;) {
    const start = rest.indexOf("{{");
    if (start < 0) break;
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    if (end < 0) throw "a {{ blank is never closed with }}";
    const inner = after.slice(0, end);
    if (inner.includes("{{")) throw "a {{ blank is never closed with }}";
    const text = clozeText(inner);
    out.push(text);
    if (rtrim(text) === "") throw "a {{ }} blank is empty";
    rest = after.slice(end + 2);
  }
  if (rest.includes("}}")) throw "a }} has no {{ before it";
  return out;
}

/** FNV-1a 64 of the deck path and the whitespace-normalised front: editing the answer keeps the id. */
export function cardId(deckPath: string, front: string): string {
  return fnvParts(deckPath, squeeze(front));
}

/** Ids for every note, in order; repeated fronts get `-2`, `-3`… */
export function cardIds(deckPath: string, deck: Deck): string[] {
  const seen = new Map<string, number>();
  return deck.notes.map((n) => {
    const id = cardId(deckPath, n.front);
    const k = (seen.get(id) ?? 0) + 1;
    seen.set(id, k);
    return k === 1 ? id : `${id}-${k}`;
  });
}

const MARKERS = ["Q:", "A:", "From:", "Quote:"];

/** A marker at the start of `line` (indent and ASCII case ignored); the text after it, one space dropped. */
function marker(line: string, m: string): string | null {
  const t = rtrimStart(line);
  if (t.length < m.length) return null;
  const head = t.slice(0, m.length);
  if (asciiLower(head) !== asciiLower(m) || Buffer.byteLength(head) !== m.length) return null;
  const rest = t.slice(m.length);
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}

const anyMarker = (s: string) => MARKERS.some((m) => marker(s, m) !== null);

function unescape(line: string): string {
  const t = rtrimStart(line);
  if (t.startsWith("\\") && anyMarker(t.slice(1))) return line.slice(0, line.length - t.length) + t.slice(1);
  return line;
}

function escape(line: string): string {
  const t = rtrimStart(line);
  const escapedAlready = t.startsWith("\\") && anyMarker(t.slice(1));
  if (anyMarker(line) || escapedAlready) return `${line.slice(0, line.length - t.length)}\\${t}`;
  return line;
}

function unquote(raw: string): string {
  const s = rtrim(raw);
  for (const q of ['"', "'"]) {
    if (Buffer.byteLength(s) >= 2 && s.startsWith(q) && s.endsWith(q)) return s.slice(1, -1);
  }
  return s;
}

/** `a, "b, c"` → `a`, `"b, c"`. */
function splitList(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const c of s) {
    if ((c === '"' || c === "'") && quote === null) {
      quote = c;
      cur += c;
    } else if (quote !== null && c === quote) {
      quote = null;
      cur += c;
    } else if (c === "," && quote === null) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function trimNewlines(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === "\n") a++;
  while (b > a && s[b - 1] === "\n") b--;
  return s.slice(a, b);
}

function trimLines(s: string): string {
  return trimNewlines(rustLines(trimNewlines(s)).map(rtrimEnd).join("\n"));
}

/** Read a deck; whatever isn't a card is kept as preamble or extra front matter. */
export function parse(input: string, fallbackTitle: string): Deck {
  const text = (input.startsWith("﻿") ? input.slice(1) : input).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const deck = emptyDeck();
  const lines = text.split("\n");
  let bodyStart = 0;
  if (lines.length && rtrimEnd(lines[0]!) === "---") {
    const endRel = lines.slice(1).findIndex((l) => rtrimEnd(l) === "---");
    if (endRel >= 0) {
      const fm = lines.slice(1, endRel + 1);
      bodyStart = endRel + 2;
      for (let i = 0; i < fm.length; i++) {
        const line = fm[i]!;
        const c = line.indexOf(":");
        const key = c >= 0 ? asciiLower(rtrim(line.slice(0, c))) : "";
        const value = c >= 0 ? rtrim(line.slice(c + 1)) : "";
        const top = !line.startsWith(" ");
        if (key === "title" && top) deck.title = unquote(value);
        else if (key === "course" && top) {
          const cc = unquote(value);
          if (cc) deck.course = cc;
          else delete deck.course;
        } else if (key === "sources" && top) {
          if (value.startsWith("[") && value.endsWith("]") && value.length >= 2) {
            for (const s of splitList(value.slice(1, -1)).map(unquote)) if (s) deck.sources.push(s);
          } else if (value) deck.sources.push(unquote(value));
          while (i + 1 < fm.length && rtrimStart(fm[i + 1]!).startsWith("- ")) {
            const s = unquote(rtrimStart(fm[i + 1]!).slice(2));
            if (s) deck.sources.push(s);
            i++;
          }
        } else if (rtrim(line) === "") {
          // blank
        } else deck.extra.push(line);
      }
    }
  }
  if (rtrim(deck.title) === "") deck.title = fallbackTitle;

  const preamble: string[] = [];
  let cur: { n: Note; part: "front" | "back" } | null = null;
  const notes: Note[] = [];
  for (const line of lines.slice(Math.min(bodyStart, lines.length))) {
    const q = marker(line, "Q:");
    if (q !== null) {
      if (cur) notes.push(cur.n);
      cur = { n: { front: q, back: "" }, part: "front" };
      continue;
    }
    if (!cur) {
      preamble.push(line);
      continue;
    }
    if (cur.part === "front") {
      const a = marker(line, "A:");
      if (a !== null) {
        cur.n.back = a;
        cur.part = "back";
        continue;
      }
      cur.n.front += "\n" + line;
    } else cur.n.back += "\n" + line;
  }
  if (cur) notes.push(cur.n);
  deck.preamble = trimLines(preamble.join("\n"));
  deck.notes = notes.map(finishNote);
  return deck;
}

/** Trims a note, takes a trailing `From:` (and `Quote:`) as its source and passage, unescapes lines. */
function finishNote(n: Note): Note {
  const hasBack = rtrim(n.back) !== "";
  let text = hasBack ? n.back : n.front;
  const take = (m: string): string | null => {
    const t = trimLines(text);
    const i = t.lastIndexOf("\n");
    const head = i >= 0 ? t.slice(0, i) : "";
    const last = i >= 0 ? t.slice(i + 1) : t;
    const r = marker(last, m);
    if (r === null || rtrim(r) === "") return null;
    text = head;
    return rtrim(r);
  };
  const before = text;
  const quote = take("Quote:");
  const source = take("From:");
  const out: Note = { front: n.front, back: n.back };
  if (source !== null) {
    out.source = source;
    if (quote !== null) {
      const q = unquote(quote);
      if (q) out.quote = q;
    }
  } else if (quote !== null) text = before;
  if (hasBack) out.back = text;
  else out.front = text;
  if (out.quote !== undefined && out.source !== undefined) {
    const sp = splitPicture(out.source);
    if (sp) {
      out.source = sp[0];
      out.picture = sp[1];
    }
  }
  const clean = (s: string) => trimLines(rustLines(s).map((l, i) => (i === 0 ? l : unescape(l))).join("\n"));
  out.front = clean(out.front);
  out.back = clean(out.back);
  return out;
}

function needsQuotes(s: string): boolean {
  return s !== rtrim(s) || /^["'[-]/.test(s) || s.includes(": ") || s.includes(" #");
}

function fmValue(s: string): string {
  if (!needsQuotes(s)) return s;
  if (!s.includes('"')) return `"${s}"`;
  // Fixed: a value with a double quote is single-quoted when it can be, so it reads back as written.
  if (!s.includes("'")) return `'${s}'`;
  return s;
}

/** The deck in the canonical form `parse` reads back exactly. */
export function write(deck: Deck): string {
  let s = "---\n";
  s += `title: ${fmValue(rtrim(deck.title))}\n`;
  if (deck.course !== undefined && rtrim(deck.course) !== "") s += `course: ${fmValue(rtrim(deck.course))}\n`;
  if (deck.sources.length) {
    s += "sources:\n";
    for (const src of deck.sources) s += `  - ${fmValue(src)}\n`;
  }
  for (const l of deck.extra) s += l + "\n";
  s += "---\n";
  if (rtrim(deck.preamble) !== "") s += "\n" + trimNewlines(deck.preamble) + "\n";
  const block = (t: string) => rustLines(t).map((l, i) => (i === 0 ? l : escape(l))).join("\n");
  for (const n of deck.notes) {
    s += "\n";
    s += `Q: ${block(rtrim(n.front))}\n`;
    if (rtrim(n.back) !== "") s += `A: ${block(rtrim(n.back))}\n`;
    if (n.source !== undefined && rtrim(n.source) !== "") {
      const q = n.quote !== undefined ? squeeze(n.quote) : "";
      if (n.picture !== undefined && q) s += `From: ${rtrim(n.source)} (p. ${n.picture}${PICTURE_MARK}\n`;
      else s += `From: ${rtrim(n.source)}\n`;
      if (q) s += `Quote: "${q}"\n`;
    }
  }
  return s;
}

/** The first problem that makes a deck unusable, thrown in plain words. */
export function validate(deck: Deck): void {
  const title = rtrim(deck.title);
  if (title === "") throw "The deck needs a title.";
  if (charLen(title) > TITLE_MAX || title.includes("\n")) throw `The title is too long: keep it under ${TITLE_MAX} characters, on one line.`;
  if (deck.notes.length === 0) throw "The deck has no cards yet.";
  if (deck.notes.length > DECK_CARDS_MAX) throw `A deck can hold up to ${DECK_CARDS_MAX} cards; split this one in two.`;
  const fronts = new Map<string, number>();
  deck.notes.forEach((n, i) => {
    const num = i + 1;
    const front = rtrim(n.front);
    if (front === "") throw `Card ${num} has no question.`;
    if (charLen(front) > FRONT_MAX) throw `Card ${num}’s question is too long (over ${FRONT_MAX} characters).`;
    if (charLen(n.back) > BACK_MAX) throw `Card ${num}’s answer is too long (over ${BACK_MAX} characters).`;
    if (kindOf(n) === "basic") {
      if (front.includes("}}")) throw `Card ${num}: a }} has no {{ before it.`;
      if (rtrim(n.back) === "") throw `Card ${num} has no answer.`;
    } else {
      try {
        clozeAnswers(front);
      } catch (e) {
        throw `Card ${num}: ${String(e)}.`;
      }
    }
    const key = squeeze(front).toLowerCase();
    const first = fronts.get(key);
    if (first !== undefined) throw `Cards ${first} and ${num} ask the same thing; change one or remove it.`;
    fronts.set(key, num);
  });
}
