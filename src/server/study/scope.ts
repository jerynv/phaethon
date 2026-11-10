import fs from "node:fs";
import path from "node:path";
import { segment, writeIn, lstat } from "./files.ts";
import { summarise } from "./lms.ts";
import * as material from "./material.ts";
import { askJson, extractJson, type Model } from "./model.ts";
import * as quote from "./quote.ts";
import { sameCourse, type Exam } from "./schedule.ts";
import { clean as cleanText, courseFiles, matchLabel, type CourseFile } from "./sources.ts";
import { COURSE_ONLY_CHAT, courseOnly } from "./store.ts";
import { byteLen, charLen, cutBytes, isAlnum, isAlpha, isAsciiDigit, splitBy, squeeze, takeChars, trimChars } from "./text.ts";
import type { Evidence, ExamScope, Notation, ScopeMap, Stated, Topic } from "./types.ts";
import { PARTS, can, folderOf, type Seen, type Visible } from "./visible.ts";

/**
 * What a course actually teaches, and what each exam covers: the scope map
 * (Rust `study::scope`). Built by the study model from the course's own text
 * as the space may see it; every quote the model gives as evidence is looked
 * up in its file and dropped when it isn't there. Kept in
 * `<vault>/.phaethon/scope/<course folder>.json`, one map per set of parts a
 * space may see, each with a fingerprint of the files it was built from.
 */

export const VERSION = 2;
export const MAP_CHUNK = 180_000;
const GUIDE_MAX = 70_000;
const HEAD_MAX = 6_000;
const TOPICS_MAX = 80;
const EVIDENCE_MAX = 4;
const TEXT_MAX = 300;
const STORE_MAX = 8 * 1024 * 1024;

export const FROM_YOU = "from you";

type Store = { maps: Record<string, ScopeMap>; stated: Stated[] };

// ---- Shared topic helpers (Rust grounded.rs, used by both sides) --------------

/** A homework, worksheet or review file: its problems test topics rather than teach them. */
export function isProblemSet(label: string): boolean {
  const name = (label.split("/").pop() ?? label).toLowerCase();
  return name.startsWith("hw") || name.includes("homework") || name.includes("problem set") || name.includes("worksheet") || name.includes("review");
}

/** Section numbers in a topic's `sections` ("3.8–3.13" → 3.8 … 3.13; "5.4"; "Chapter 2" → none). */
export function sectionNumbers(sections: string | undefined | null): string[] {
  if (!sections) return [];
  const toks = splitBy(sections, (c) => !(isAsciiDigit(c) || c === "."))
    .map((t) => trimChars(t, "."))
    .filter((t) => t.includes("."));
  if (toks.length === 2) {
    const [a, b] = toks as [string, string];
    const [am, ax] = a.split(".");
    const [bm, by] = b.split(".");
    const x = Number(ax);
    const y = Number(by);
    if (am === bm && a.split(".").length === 2 && b.split(".").length === 2 && /^\d+$/.test(ax ?? "") && /^\d+$/.test(by ?? "") && x <= y && y - x <= 30) {
      const out: string[] = [];
      for (let i = x; i <= y; i++) out.push(`${am}.${i}`);
      return out;
    }
  }
  return toks;
}

// ---- Where it lives -------------------------------------------------------------

/** The vault a course folder is in (`<vault>/courses/<folder>`). */
export function vaultOf(visible: Visible, seen: Seen): string | null {
  const dir = visible.dirOf(seen);
  return dir ? path.dirname(path.dirname(dir)) : null;
}

function storeRel(seen: Seen): string {
  return `.phaethon/scope/${segment(folderOf(seen))}.json`;
}

const DAMAGED = "The course’s scope file can’t be read, so Phaethon won’t overwrite it. Fix or remove it, then try again:";

/**
 * The store for a course. Reading for display treats a damaged file as empty;
 * reading to change it refuses, so a damaged file (other spaces' maps, what the
 * person said about exams) is never silently replaced.
 */
function loadStore(vault: string, seen: Seen, forWrite: boolean): Store {
  const rel = storeRel(seen);
  const file = path.join(vault, rel);
  const empty: Store = { maps: {}, stated: [] };
  const st = lstat(file);
  if (!st) return empty;
  const damaged = (why: string): Store => {
    if (forWrite) throw `${DAMAGED} ${rel} (${why}).`;
    return empty;
  };
  if (!st.isFile() || st.size > STORE_MAX) return damaged("it isn’t a small plain file");
  let v: unknown;
  try {
    v = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return damaged((e as Error).message);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return damaged("it isn’t a JSON object");
  const o = v as { maps?: unknown; stated?: unknown };
  const maps: Record<string, ScopeMap> = {};
  if (o.maps && typeof o.maps === "object" && !Array.isArray(o.maps)) {
    for (const [k, m] of Object.entries(o.maps as Record<string, unknown>)) {
      const map = readMap(m);
      if (map) maps[k] = map;
      else if (forWrite) return damaged(`its map for “${k}” isn’t laid out as Phaethon expects`);
    }
  }
  const stated: Stated[] = [];
  if (Array.isArray(o.stated)) {
    for (const s of o.stated) {
      const x = s as Partial<Stated>;
      if (x && typeof x.exam === "string" && typeof x.text === "string" && typeof x.at === "number") {
        const item: Stated = { exam: x.exam, text: x.text, at: x.at, includes: strArr(x.includes), excludes: strArr(x.excludes) };
        if (typeof x.resolvedFor === "string") item.resolvedFor = x.resolvedFor;
        stated.push(item);
      } else if (forWrite) return damaged("a statement about an exam isn’t laid out as Phaethon expects");
    }
  }
  return { maps, stated };
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function readEvidence(v: unknown): Evidence[] {
  if (!Array.isArray(v)) return [];
  const out: Evidence[] = [];
  for (const e of v) {
    const x = e as Partial<Evidence>;
    if (!x || typeof x.source !== "string" || typeof x.quote !== "string") continue;
    const ev: Evidence = { source: x.source, quote: x.quote };
    if (typeof x.at === "string") ev.at = x.at;
    if (typeof x.picture === "number") ev.picture = x.picture;
    out.push(ev);
  }
  return out;
}

/** A stored map as serde read it (required fields checked; defaults filled). */
function readMap(m: unknown): ScopeMap | null {
  const o = m as Record<string, unknown>;
  if (!o || typeof o !== "object") return null;
  if (typeof o.version !== "number" || typeof o.course !== "string" || typeof o.name !== "string" || !Array.isArray(o.parts)) return null;
  if (typeof o.fingerprint !== "string" || typeof o.built !== "number" || !Array.isArray(o.topics)) return null;
  const topics: Topic[] = [];
  for (const t of o.topics as Record<string, unknown>[]) {
    if (!t || typeof t.id !== "string" || typeof t.title !== "string" || !Array.isArray(t.evidence)) return null;
    const topic: Topic = {
      id: t.id,
      title: t.title,
      terms: strArr(t.terms),
      weight: typeof t.weight === "number" ? t.weight : 1.0,
      homework: strArr(t.homework),
      evidence: readEvidence(t.evidence),
    };
    if (typeof t.sections === "string") topic.sections = t.sections;
    if (t.reference === true) topic.reference = true;
    const ab = readEvidence(t.assignedBy);
    if (ab.length) topic.assignedBy = ab;
    topics.push(orderTopic(topic));
  }
  const notation: Notation[] = [];
  for (const n of (Array.isArray(o.notation) ? o.notation : []) as Record<string, unknown>[]) {
    if (n && typeof n.symbol === "string" && typeof n.meaning === "string") notation.push({ symbol: n.symbol, meaning: n.meaning, evidence: readEvidence(n.evidence) });
  }
  const exams: ExamScope[] = [];
  for (const e of (Array.isArray(o.exams) ? o.exams : []) as Record<string, unknown>[]) {
    if (!e || typeof e.title !== "string" || typeof e.known !== "boolean") continue;
    const ex: ExamScope = {
      title: e.title,
      known: e.known,
      summary: typeof e.summary === "string" ? e.summary : "",
      includes: strArr(e.includes),
      excludes: strArr(e.excludes),
      excludedWords: strArr(e.excludedWords),
      homework: strArr(e.homework),
      evidence: readEvidence(e.evidence),
      fromUser: e.fromUser === true,
    };
    if (typeof e.date === "string") ex.date = e.date;
    exams.push(orderExam(ex));
  }
  return {
    version: o.version,
    course: o.course,
    name: o.name,
    parts: strArr(o.parts),
    fingerprint: o.fingerprint,
    built: o.built,
    topics,
    notation,
    exams,
    dropped: typeof o.dropped === "number" ? o.dropped : 0,
  };
}

/** Field order as serde wrote it (id, title, sections, terms, weight, homework, evidence, reference, assignedBy). */
function orderTopic(t: Topic): Topic {
  const out: Topic = { id: t.id, title: t.title } as Topic;
  if (t.sections !== undefined) out.sections = t.sections;
  out.terms = t.terms;
  out.weight = t.weight;
  out.homework = t.homework;
  out.evidence = t.evidence;
  if (t.reference) out.reference = true;
  if (t.assignedBy?.length) out.assignedBy = t.assignedBy;
  return out;
}

function orderExam(e: ExamScope): ExamScope {
  const out = { title: e.title } as ExamScope;
  if (e.date !== undefined) out.date = e.date;
  Object.assign(out, {
    known: e.known,
    summary: e.summary,
    includes: e.includes,
    excludes: e.excludes,
    excludedWords: e.excludedWords,
    homework: e.homework,
    evidence: e.evidence,
    fromUser: e.fromUser,
  });
  return out;
}

function saveStore(vault: string, seen: Seen, store: Store): void {
  const sorted: Record<string, ScopeMap> = {};
  for (const k of Object.keys(store.maps).sort()) sorted[k] = store.maps[k]!;
  try {
    writeIn(vault, storeRel(seen), JSON.stringify({ maps: sorted, stated: store.stated }, null, 2));
  } catch (e) {
    throw `The course’s scope couldn’t be saved: ${(e as Error).message}`;
  }
}

/** The parts a space sees, as the key its map is kept under. */
export function partsKey(seen: Seen): string {
  return PARTS.filter((p) => can(seen, p)).join(",");
}

/** FNV-1a 64 over each file's label, a 0 byte, size and modified time (u64 little-endian). */
export function fingerprint(files: readonly CourseFile[]): string {
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  const eat = (b: number) => {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & MASK;
  };
  for (const f of files) {
    for (const b of Buffer.from(f.label, "utf8")) eat(b);
    eat(0);
    const buf = Buffer.alloc(16);
    buf.writeBigUInt64LE(BigInt(Math.max(0, Math.trunc(f.size))) & MASK, 0);
    buf.writeBigUInt64LE(BigInt(Math.max(0, Math.trunc(f.modified))) & MASK, 8);
    for (const b of buf) eat(b);
  }
  return h.toString(16).padStart(16, "0");
}

/** The map kept for what this space sees of `seen`, and whether the course is unchanged since. */
export function cached(visible: Visible, seen: Seen, files?: readonly CourseFile[] | null): [ScopeMap, boolean] | null {
  const vault = vaultOf(visible, seen);
  if (!vault) return null;
  const map = loadStore(vault, seen, false).maps[partsKey(seen)];
  if (!map || map.version !== VERSION) return null;
  const fresh = fingerprint(files ?? courseFiles(visible, seen)) === map.fingerprint;
  return [map, fresh];
}

export function stated(visible: Visible, seen: Seen): Stated[] {
  const vault = vaultOf(visible, seen);
  return vault ? loadStore(vault, seen, false).stated : [];
}

/** Keeps what the person says `exam` covers (an empty `text` forgets it). */
export function state(visible: Visible, seen: Seen, examRaw: string, textRaw: string, now: number): void {
  const exam = squeeze(examRaw);
  const text = textRaw.trim();
  if (exam === "" || charLen(exam) > 80) throw "Name the exam in a few words.";
  if (charLen(text) > 1_000) throw "That’s too long; say what it covers in a sentence or two.";
  const vault = vaultOf(visible, seen);
  if (!vault) throw "That course isn’t there any more.";
  const store = loadStore(vault, seen, true);
  store.stated = store.stated.filter((s) => examKey(s.exam) !== examKey(exam));
  if (text) store.stated.push({ exam, text, at: now, includes: [], excludes: [] });
  saveStore(vault, seen, store);
}

function saveMap(visible: Visible, seen: Seen, map: ScopeMap): void {
  const vault = vaultOf(visible, seen);
  if (!vault) throw "That course isn’t there any more.";
  const store = loadStore(vault, seen, true);
  store.maps[partsKey(seen)] = map;
  saveStore(vault, seen, store);
}

function saveStated(visible: Visible, seen: Seen, s: Stated): void {
  const vault = vaultOf(visible, seen);
  if (!vault) throw "That course isn’t there any more.";
  const store = loadStore(vault, seen, true);
  store.stated = store.stated.filter((x) => examKey(x.exam) !== examKey(s.exam));
  store.stated.push(s);
  saveStore(vault, seen, store);
}

// ---- Words ----------------------------------------------------------------------

export function squash(s: string): string {
  let out = "";
  for (const c of s) if (isAlnum(c)) out += c.toLowerCase();
  return out;
}

export function examKey(s: string): string {
  return examTokens(s).join(" ");
}

const FILLER = ["the", "a", "my", "for", "on", "of", "practice", "please", "and", "to", "next", "upcoming"];

/** An exam's name as words: lower case, "exam" and "quiz" read as "test", filler left out. */
export function examTokens(s: string): string[] {
  const out: string[] = [];
  for (const w of splitBy(s.toLowerCase(), (c) => !isAlnum(c)).filter((w) => w !== "")) {
    const chars = [...w];
    const i = chars.findIndex(isAsciiDigit);
    const split = i > 0 && chars.slice(0, i).every(isAlpha) ? [chars.slice(0, i).join(""), chars.slice(i).join("")] : [w];
    for (let p of split) {
      if (p === "exam" || p === "quiz" || p === "examination") p = "test";
      if (!FILLER.includes(p)) out.push(p);
    }
  }
  return out;
}

const within = (small: string[], big: string[]): boolean => small.length > 0 && small.every((w) => big.includes(w));

/** The exam `wanted` names among `exams`: same words, all its words, or one named inside it. */
export function findExam(exams: readonly ExamScope[], wanted: string): ExamScope | null {
  const w = examTokens(wanted);
  if (!w.length) return null;
  const exact = exams.find((e) => examTokens(e.title).join("\u0000") === w.join("\u0000"));
  if (exact) return exact;
  const hits = exams.filter((e) => within(w, examTokens(e.title)) || within(examTokens(e.title), w));
  return hits.length === 1 ? hits[0]! : null;
}

/** An exam's title, if exactly one of `exams` is named in `text`. */
export function namedExam(exams: readonly ExamScope[], text: string): string | null {
  const t = examTokens(text);
  const hits = exams.filter((e) => within(examTokens(e.title), t));
  return hits.length === 1 ? hits[0]!.title : null;
}

// ---- Building -------------------------------------------------------------------

function guideRank(label: string): [number, boolean] {
  const l = label.toLowerCase();
  const name = l.split("/").pop() ?? l;
  const rel = l.split("/").slice(2).join("/") || l;
  const review = ["review", "exam", "midterm", "final", "study guide", "practice", "test "].some((k) => name.includes(k));
  const rank =
    rel === "announcements.md"
      ? 0
      : name.includes("syllabus") || name.includes("schedule") || review
        ? 1
        : rel === "assignments.md" || isProblemSet(label) || name.startsWith("ps")
          ? 2
          : 3;
  return [rank, rank < 3];
}

/** The course text for mapping, in calls of at most MAP_CHUNK bytes; most useful first. */
export function mapChunks(files: readonly CourseFile[]): string[] {
  const ranked = files
    .map((f) => ({ f, r: guideRank(f.label) }))
    .sort((a, b) => a.r[0] - b.r[0] || Buffer.compare(Buffer.from(a.f.label), Buffer.from(b.f.label)));
  const out: string[] = [];
  let cur = "";
  for (const { f, r } of ranked) {
    const text = cleanText(f.text);
    if (text.trim() === "") continue;
    const cap = r[1] ? GUIDE_MAX : HEAD_MAX;
    const kept = cutBytes(text, cap);
    const more = kept.length < text.length ? "\n[… the rest of this file isn’t shown here]" : "";
    const block = `<source path="${f.label}">\n${kept}${more}\n</source>\n\n`;
    if (cur !== "" && byteLen(cur) + byteLen(block) > MAP_CHUNK) {
      out.push(cur);
      cur = "";
    }
    cur += block;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

export const MAP_SYSTEM = `You map what a course teaches, from its own materials, for a student preparing for its exams. Precision matters more than completeness: a student will be quizzed only on what you list, so never add a topic, exclusion or exam scope the materials don't state.

From the <source> files (and the current map, if one is given, which you extend and correct), list:
- "topics": what the course teaches, in the order it teaches it, at the grain of a lecture section or a homework problem (aim for 10 to 40 topics). Each: "id" (keep ids from the current map; new ones "t" plus a number), "title" (the course's own words), "sections" (the course's numbering if it has one, like "3.8–3.13", else omit), "terms" (2 to 8 words or short phrases the course uses for it), "weight" (1 to 5: how much the course leans on it: homework problems, lecture time, review sheets, "focus on"), "homework" (problems on it, like "HW 4 #3"), and "evidence": 1 to 3 passages that show the course teaches it.
- A topic whose evidence is only in readings/ files (textbooks and other readings the course links to) counts only where the course points students to it: give it "assignedBy", 1 or 2 passages from the syllabus, assignments, announcements, modules or the course's own pages that assign or point to that chapter, section or topic, naming it (same form as evidence). Without one it is kept as reference only and never tested. Never give a topic for a chapter of a textbook nothing in the course points to.
- "notation": symbols and notation the course defines that a student must know (like |s| for a string's length, ε for the empty string): "symbol", "meaning", "evidence" (one passage).
- "exams": every exam the materials mention. Each: "title" as the course names it ("Test 1"), "date" (YYYY-MM-DD) if stated, "through" (the last homework or section it covers, if stated), "includes" (topic ids it covers), "excludes" (topic ids it explicitly leaves out), "excludedWords" (what it leaves out, in the course's words), "homework" (paths of the homework files it covers, copied from the source paths), "summary" (a few words, like "through HW 6; not graphs or combinatorics"), and "evidence": the passages that say what it covers. If the materials don't say what an exam covers, give it with "includes": [] and no evidence. Never infer an exam's coverage from dates alone.

Evidence: {"source": the <source> path copied exactly, "quote": words copied exactly from that source, one or two sentences or a heading line (at least five words), never paraphrased, never stitched together}. Quotes are checked against the files: one that isn't there is thrown away, and a topic with no real evidence is dropped.

Reply with only JSON, no prose: {"topics": [...], "notation": [...], "exams": [...]}`;

/** The course's files, to check quotes against (each compacted once). */
export class Docs {
  private readonly files: { label: string; text: string; compact?: ReturnType<typeof quote.compact> }[];
  private readonly pictured: material.PageRef[] = [];

  constructor(files: readonly CourseFile[]) {
    this.files = files.map((f) => ({ label: f.label, text: f.text }));
  }

  /** Notes that the model was shown these pages as pictures. */
  shown(pages: readonly material.PageRef[]): void {
    for (const x of pages) if (!this.pictured.some(([l, p]) => l === x[0] && p === x[1])) this.pictured.push([x[0], x[1]]);
  }

  labels(): string[] {
    return this.files.map((f) => f.label);
  }

  private index(source: string): number {
    const labels = this.labels();
    const l = matchLabel(source, labels);
    return l === null ? -1 : labels.indexOf(l);
  }

  /** The quote checked against the file it names, as kept evidence, or null when it isn't there. */
  check(source: string, q: string): Evidence | null {
    const i = this.index(source);
    if (i < 0) return null;
    const doc = this.files[i]!;
    doc.compact ??= quote.compact(doc.text);
    const f = quote.findIn(doc.text, doc.compact, q);
    if (!f) {
      const shown = this.pictured.filter(([l]) => l === doc.label).map(([, p]) => p);
      const page = material.pictureQuote(doc.text, shown, q);
      if (page === null) return null;
      return { source: doc.label, quote: quote.tidy(q), at: `p. ${page}`, picture: page };
    }
    const ev: Evidence = { source: doc.label, quote: quote.tidy(q) };
    const at = quote.locate(doc.text, f.start, isProblemSet(doc.label));
    if (at !== null) ev.at = at;
    return ev;
  }
}

/** A file among the course's readings. */
export function isReading(label: string): boolean {
  const rel = label.split("/").slice(2).join("/");
  return label.split("/").length >= 3 && rel.toLowerCase().startsWith("readings/");
}

const POINT_SKIP = ["about", "using", "their", "with", "from", "basic", "introduction", "definitions"];

/** Whether a course passage points to a topic: its section, its chapter, a term, or a longer title word. */
export function pointsTo(quoteText: string, sections: string | undefined | null, terms: readonly string[], title: string): boolean {
  const q = quoteText.toLowerCase();
  const hasNumber = (n: string): boolean => {
    let from = 0;
    for (;;) {
      const i = q.indexOf(n, from);
      if (i < 0) return false;
      const before = q[i - 1];
      const after = q[i + n.length];
      if (!(before !== undefined && (isAsciiDigit(before) || before === ".")) && !(after !== undefined && isAsciiDigit(after))) return true;
      from = i + 1;
    }
  };
  const numbers = sectionNumbers(sections);
  if (numbers.some(hasNumber)) return true;
  const chapters = new Set<string>(numbers.map((n) => n.split(".")[0]!));
  if (sections && [...sections].every(isAsciiDigit)) chapters.add(sections);
  for (const c of chapters) if (["chapter ", "chapters ", "ch. ", "ch "].some((w) => hasNumber(`${w}${c}`))) return true;
  return (
    terms.map((t) => t.toLowerCase()).some((t) => charLen(t) >= 4 && q.includes(t)) ||
    splitBy(title.toLowerCase(), (c) => !isAlnum(c)).some((w) => charLen(w) >= 5 && !POINT_SKIP.includes(w) && q.includes(w))
  );
}

function textField(v: unknown, k: string, max: number): string {
  const x = (v as Record<string, unknown> | null)?.[k];
  const s = typeof x === "string" ? x : typeof x === "number" ? String(x) : "";
  return takeChars(squeeze(s), max);
}

function stringsField(v: unknown, k: string, maxItems: number, maxLen: number): string[] {
  const x = (v as Record<string, unknown> | null)?.[k];
  if (Array.isArray(x)) {
    return x
      .map((e) => (typeof e === "string" ? takeChars(e.trim(), maxLen) : typeof e === "number" ? String(e) : null))
      .filter((e): e is string => e !== null && e !== "")
      .slice(0, maxItems);
  }
  if (typeof x === "string" && x.trim() !== "") return [takeChars(x.trim(), maxLen)];
  return [];
}

function checkEvidence(v: unknown, docs: Docs, max: number): [Evidence[], number] {
  const list = Array.isArray(v) ? v : v && typeof v === "object" ? [v] : [];
  const kept: Evidence[] = [];
  let dropped = 0;
  for (const e of list) {
    const o = (e ?? {}) as Record<string, unknown>;
    const source = typeof o.source === "string" ? o.source.trim() : "";
    const q = typeof o.quote === "string" ? o.quote.trim() : "";
    if (source === "" && q === "") continue;
    const ev = docs.check(source, q);
    if (!ev) dropped++;
    else if (kept.length < max && !kept.some((k) => k.quote === ev.quote)) kept.push(ev);
  }
  return [kept, dropped];
}

export type Checked = { topics: Topic[]; notation: Notation[]; exams: ExamScope[]; dropped: number };

/** Checks a model's map; throws a problem string only for a reply that isn't a map at all. */
export function checkMap(v: unknown, docs: Docs, priorIds: ReadonlySet<string>): Checked {
  const topicsV = (v as Record<string, unknown> | null)?.topics;
  if (!Array.isArray(topicsV)) throw 'expected an object with a "topics" array';
  let dropped = 0;
  const topics: Topic[] = [];
  const ids = new Map<string, string>();
  const used = new Set<string>();
  /** Ids the model gave topics that were dropped: an exam naming one must not land on another topic. */
  const droppedIds = new Set<string>();
  let next = 1;
  for (const t of topicsV.slice(0, TOPICS_MAX * 2)) {
    const title = textField(t, "title", 160);
    if (!title) continue;
    const [evidence, d] = checkEvidence((t as Record<string, unknown>)?.evidence, docs, EVIDENCE_MAX);
    dropped += d;
    const said = textField(t, "id", 20);
    if (!evidence.length || topics.length >= TOPICS_MAX) {
      if (said) droppedIds.add(said);
      continue;
    }
    let id: string;
    if (said && priorIds.has(said) && !used.has(said)) id = said;
    else {
      for (;;) {
        const c = `t${next++}`;
        if (!used.has(c) && !priorIds.has(c)) {
          id = c;
          break;
        }
      }
    }
    used.add(id);
    if (said) ids.set(said, id);
    const w = (t as Record<string, unknown>).weight;
    const wn = typeof w === "number" ? w : typeof w === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(w) && w.trim() === w ? Number(w) : NaN;
    const weight = Math.min(Math.max(Number.isFinite(wn) ? wn : 2.0, 1.0), 5.0);
    const sections = textField(t, "sections", 40) || undefined;
    const terms = stringsField(t, "terms", 8, 60);
    let assignedBy: Evidence[] = [];
    let reference = false;
    if (evidence.every((e) => isReading(e.source))) {
      const [ab, d2] = checkEvidence((t as Record<string, unknown>).assignedBy, docs, 2);
      dropped += d2;
      assignedBy = ab.filter((e) => !isReading(e.source) && pointsTo(e.quote, sections, terms, title));
      reference = assignedBy.length === 0;
    }
    const topic: Topic = { id, title, terms, weight, homework: stringsField(t, "homework", 12, 40), evidence };
    if (sections) topic.sections = sections;
    if (reference) topic.reference = true;
    if (assignedBy.length) topic.assignedBy = assignedBy;
    topics.push(orderTopic(topic));
  }
  if (!topics.length) throw "none of the topics had a passage that is really in the files: quote each one exactly";
  const notation: Notation[] = [];
  const notationV = (v as Record<string, unknown>).notation;
  for (const n of (Array.isArray(notationV) ? notationV : []).slice(0, 40)) {
    const symbol = textField(n, "symbol", 60);
    const meaning = textField(n, "meaning", 200);
    const [evidence, d] = checkEvidence((n as Record<string, unknown>)?.evidence, docs, 1);
    dropped += d;
    if (symbol && meaning && evidence.length) notation.push({ symbol, meaning, evidence });
  }
  const labels = docs.labels();
  const exams: ExamScope[] = [];
  const examsV = (v as Record<string, unknown>).exams;
  for (const e of (Array.isArray(examsV) ? examsV : []).slice(0, 12)) {
    const title = textField(e, "title", 80);
    if (!title || exams.some((x) => examKey(x.title) === examKey(title))) continue;
    const [evidence, d] = checkEvidence((e as Record<string, unknown>)?.evidence, docs, EVIDENCE_MAX);
    dropped += d;
    const mapIds = (k: string) =>
      stringsField(e, k, TOPICS_MAX, 20)
        .map((i) => ids.get(i) ?? (used.has(i) && !droppedIds.has(i) ? i : null))
        .filter((i): i is string => i !== null);
    const excludes = mapIds("excludes");
    const includes = mapIds("includes").filter((i) => !excludes.includes(i));
    const excludedWords = stringsField(e, "excludedWords", 12, 60);
    const known = evidence.length > 0 && includes.length > 0;
    const dateText = textField(e, "date", 10);
    const date = dateText && parseDateOk(dateText) ? dateText : undefined;
    const homework = stringsField(e, "homework", 20, 300)
      .map((h) => matchLabel(h, labels))
      .filter((h): h is string => h !== null);
    const summary = textField(e, "summary", TEXT_MAX);
    if (known) {
      const ex: ExamScope = { title, known, summary, includes, excludes, excludedWords, homework, evidence, fromUser: false };
      if (date) ex.date = date;
      exams.push(orderExam(ex));
    } else exams.push(unknownExam(title, date));
  }
  return { topics, notation, exams, dropped };
}

function parseDateOk(d: string): boolean {
  // lms::store::parse_time accepts it (a date, or a date and time).
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && Number(d.slice(5, 7)) >= 1 && Number(d.slice(5, 7)) <= 12 && Number(d.slice(8, 10)) >= 1 && Number(d.slice(8, 10)) <= 31;
}

export function unknownExam(title: string, date?: string): ExamScope {
  const e: ExamScope = { title, known: false, summary: "", includes: [], excludes: [], excludedWords: [], homework: [], evidence: [], fromUser: false };
  if (date !== undefined) e.date = date;
  return orderExam(e);
}

/** The map so far, as the next mapping call sees it (compact JSON; nulls written). */
function priorJson(topics: Topic[], notation: Notation[], exams: ExamScope[]): string {
  const ev = (list: Evidence[]) => list.map((e) => ({ source: e.source, quote: e.quote }));
  return JSON.stringify({
    topics: topics.map((t) => ({ id: t.id, title: t.title, sections: t.sections ?? null, terms: t.terms, weight: t.weight, homework: t.homework, evidence: ev(t.evidence) })),
    notation: notation.map((n) => ({ symbol: n.symbol, meaning: n.meaning, evidence: ev(n.evidence) })),
    exams: exams.map((e) => ({
      title: e.title,
      date: e.date ?? null,
      includes: e.includes,
      excludes: e.excludes,
      excludedWords: e.excludedWords,
      homework: e.homework,
      summary: e.summary,
      evidence: ev(e.evidence),
    })),
  });
}

function forThisCourse(e: Exam, seen: Seen): boolean {
  return e.course === undefined || e.course === null || sameCourse(e.course, folderOf(seen)) || sameCourse(e.course, seen.state.name);
}

function examsNote(exams: readonly Exam[], seen: Seen): string {
  const mine = exams.filter((e) => forThisCourse(e, seen)).map((e) => `${e.title} on ${e.date}`);
  return mine.length ? `\n\nThe student's calendar lists these exams (dates only, not what they cover): ${mine.join("; ")}.` : "";
}

/**
 * Merges a later chunk's topics into the map so far. The later reply is the
 * model's whole map in its order; an earlier topic it lost is put back right
 * after the earlier topic it followed, so the map stays in the order taught.
 */
export function mergeTopics(later: Topic[], earlier: Topic[]): Topic[] {
  const out = [...later];
  const same = (a: Topic, b: Topic) => a.id === b.id || squash(a.title) === squash(b.title);
  earlier.forEach((old, i) => {
    if (out.some((x) => same(x, old))) return;
    let at = -1;
    for (let j = i - 1; j >= 0 && at < 0; j--) at = out.findIndex((x) => same(x, earlier[j]!));
    if (at < 0) {
      // Before the first earlier topic that comes after it, or at the end.
      let after = -1;
      for (let j = i + 1; j < earlier.length && after < 0; j++) after = out.findIndex((x) => same(x, earlier[j]!));
      out.splice(after < 0 ? out.length : after, 0, old);
    } else out.splice(at + 1, 0, old);
  });
  return out;
}

/** Notation by symbol: a later definition replaces the earlier one; earlier symbols are kept. */
export function mergeNotation(later: Notation[], earlier: Notation[]): Notation[] {
  const out = earlier.map((o) => later.find((n) => n.symbol === o.symbol) ?? o);
  for (const n of later) if (!out.some((o) => o.symbol === n.symbol)) out.push(n);
  return out;
}

/** Maps the course as this space sees it and keeps the map. `onProgress(done, total)` per call. */
export async function build(
  visible: Visible,
  seen: Seen,
  exams: readonly Exam[],
  model: Model,
  now: number,
  onProgress: (done: number, total: number) => void,
): Promise<ScopeMap> {
  const files = courseFiles(visible, seen);
  if (!files.length) throw `There’s nothing this space can read in ${seen.state.name} to map.`;
  const docs = new Docs(files);
  const chunks = mapChunks(files);
  let topics: Topic[] = [];
  let notation: Notation[] = [];
  let examsFound: ExamScope[] = [];
  let dropped = 0;
  const calendar = examsNote(exams, seen);
  const system = courseOnly(MAP_SYSTEM);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    onProgress(i, chunks.length);
    const prior =
      i === 0
        ? ""
        : `\n\n<current_map>\n${priorJson(topics, notation, examsFound)}\n</current_map>\n\nExtend and correct the current map with what these files add; reply with the whole map.`;
    let pictures: ReturnType<typeof material.pictures> = [];
    if (model.showsPictures()) {
      const pages = material.pagesInChunk(seen, chunk, material.MAP_PICTURES);
      pictures = material.pictures(visible, seen, pages, material.MAP_PICTURES);
      docs.shown(pages.filter(([l, p]) => pictures.some((x) => x.label === `${l}, page ${p}` || x.label === l)));
    }
    const user = `Course: ${seen.state.name}${calendar}\n\n${chunk}${prior}${material.picturesNote(pictures)}`;
    const priorIds = new Set(topics.map((t) => t.id));
    const reply = await model.completeSeeing(system, user, pictures);
    let checked: Checked;
    try {
      const v = extractJson(reply);
      if (v === undefined) throw "the reply had no JSON in it";
      checked = checkMap(v, docs, priorIds);
    } catch (problem) {
      if (typeof problem !== "string") throw problem;
      const retry = `${user}\n\n<previous_reply>\n${takeChars(reply, 3_000)}\n</previous_reply>\n\nThat reply couldn't be used: ${problem}. Answer again with only the corrected JSON.`;
      const again = await model.completeSeeing(system, retry, pictures);
      const v = extractJson(again);
      if (v === undefined) throw "The course couldn’t be mapped (the answer had no map in it). Try again.";
      try {
        checked = checkMap(v, docs, priorIds);
      } catch (p) {
        throw `The course couldn’t be mapped (${typeof p === "string" ? p : (p as Error).message}). Try again.`;
      }
    }
    dropped += checked.dropped;
    topics = mergeTopics(checked.topics, topics);
    notation = mergeNotation(checked.notation, notation);
    const ex = [...checked.exams];
    for (const old of examsFound) {
      const at = ex.findIndex((x) => examKey(x.title) === examKey(old.title));
      if (at < 0) ex.push(old);
      else if (!ex[at]!.known && old.known) ex[at] = old;
    }
    examsFound = ex;
  }
  onProgress(chunks.length, chunks.length);
  for (const e of exams.filter((x) => forThisCourse(x, seen))) {
    const x = examsFound.find((f) => examKey(f.title) === examKey(e.title));
    if (x) {
      if (x.date === undefined) {
        x.date = takeChars(e.date, 10);
        Object.assign(x, orderExam(x));
      }
    } else if (e.title.trim() !== "") examsFound.push(unknownExam(e.title.trim(), takeChars(e.date, 10)));
  }
  const map: ScopeMap = {
    version: VERSION,
    course: folderOf(seen),
    name: seen.state.name,
    parts: PARTS.filter((p) => can(seen, p)),
    fingerprint: fingerprint(files),
    built: now,
    topics,
    notation,
    exams: examsFound.map(orderExam),
    dropped,
  };
  saveMap(visible, seen, map);
  return map;
}

// ---- The person's word ----------------------------------------------------------

export const RESOLVE_SYSTEM = `A student told you what an exam covers. Match what they said to the course's topics (given with ids, in the order taught). "includes": the ids of every topic the exam covers by what they said (for "through HW 6" or "up to section 5.4", every topic up to that point); "excludes": the ids of topics they said it leaves out. Use only what they said; when they don't say, leave the topic out of both.

Reply with only JSON: {"includes": ["t1"], "excludes": ["t9"], "summary": "a few words, like: through HW 6; not graphs or combinatorics"}`;

const sectionsSuffix = (t: { sections?: string }) => (t.sections !== undefined ? ` (${t.sections})` : "");

/** The scope an exam has for generating: the person's word over what was found; null when neither says. */
export async function examScope(visible: Visible, seen: Seen, map: ScopeMap, exam: string, model: Model): Promise<ExamScope | null> {
  const found = findExam(map.exams, exam);
  const said = stated(visible, seen).find((s) => findExam([unknownExam(s.exam)], exam) !== null);
  if (!said) return found?.known ? found : null;
  const s: Stated = { ...said };
  if (s.resolvedFor !== map.fingerprint || s.includes.length === 0) {
    const list = map.topics.map((t) => `${t.id}: ${t.title}${sectionsSuffix(t)}`);
    const homework = map.topics.filter((t) => t.homework.length).map((t) => `${t.id}: ${t.homework.join(", ")}`);
    const user = `Exam: ${s.exam}\nWhat the student said it covers: ${s.text}\n\nTopics:\n${list.join("\n")}\n\nHomework on each topic:\n${homework.join("\n")}`;
    const ids = new Set(map.topics.map((t) => t.id));
    const [inc, exc] = await askJson(model, courseOnly(RESOLVE_SYSTEM), user, (v) => {
      const pick = (k: string) => stringsField(v, k, TOPICS_MAX, 20).filter((i) => ids.has(i));
      const ex = pick("excludes");
      const inc2 = pick("includes").filter((i) => !ex.includes(i));
      if (!inc2.length) throw "no topic id from the list is included";
      return [inc2, ex] as const;
    });
    s.includes = [...inc];
    s.excludes = [...exc];
    s.resolvedFor = map.fingerprint;
    saveStated(visible, seen, s);
  }
  const out: ExamScope = {
    title: found?.title ?? s.exam,
    known: true,
    summary: takeChars(s.text, TEXT_MAX),
    includes: [...s.includes],
    excludes: [...s.excludes],
    excludedWords: [],
    homework: found?.homework ?? [],
    evidence: [{ source: FROM_YOU, quote: s.text }],
    fromUser: true,
  };
  if (found?.date !== undefined) out.date = found.date;
  return orderExam(out);
}

// ---- Using it -------------------------------------------------------------------

/** Questions per topic: by weight (largest remainders) in course order; with fewer than topics, spread one each. */
export function allocate(topics: readonly Topic[], count: number): [string, number][] {
  if (!topics.length || count === 0) return topics.map((t) => [t.id, 0]);
  const w = (t: Topic) => Math.max(t.weight, 0.1);
  const n = topics.map(() => 0);
  const total = topics.reduce((s, t) => s + w(t), 0);
  if (count < topics.length) {
    let start = 0;
    let acc = 0;
    for (let k = 0; k < count; k++) {
      const target = (total * (k + 1)) / count;
      let end = start;
      while (end < topics.length - (count - k - 1) && (end === start || acc + w(topics[end]!) <= target + 1e-9)) {
        acc += w(topics[end]!);
        end++;
      }
      let pick = start;
      for (let i = start; i < end; i++) if (topics[i]!.weight > topics[pick]!.weight) pick = i;
      n[pick] = 1;
      start = end;
    }
  } else {
    const exact = topics.map((t) => (w(t) * count) / total);
    exact.forEach((x, i) => (n[i] = Math.max(Math.floor(x), 1)));
    const sum = () => n.reduce((a, b) => a + b, 0);
    while (sum() > count) {
      let best = -1;
      for (let i = 0; i < n.length; i++) if (n[i]! > 1 && (best < 0 || exact[i]! - n[i]! < exact[best]! - n[best]!)) best = i;
      n[best]!--;
    }
    while (sum() < count) {
      let best = 0;
      for (let i = 1; i < n.length; i++) if (exact[i]! - n[i]! > exact[best]! - n[best]!) best = i;
      n[best]!++;
    }
  }
  return topics.map((t, i) => [t.id, n[i]!]);
}

/** The topics an exam covers, in course order; every taught topic with no exam. */
export function inScope(map: ScopeMap, exam: ExamScope | null): Topic[] {
  return map.topics.filter((t) => !t.reference && (!exam || (exam.includes.includes(t.id) && !exam.excludes.includes(t.id))));
}

/** "Test 1: through HW 6; not graphs or combinatorics". */
export function scopeWords(e: ExamScope): string {
  if (!e.known) return `${e.title}: I couldn’t find what it covers`;
  let s = e.summary === "" ? `${e.includes.length} topics` : e.summary;
  const lower = s.toLowerCase();
  const unsaid = e.excludedWords.filter((w) => !lower.includes(w.toLowerCase()));
  if (unsaid.length) s += `; not ${unsaid.join(" or ")}`;
  return `${e.title}: ${s}`;
}

/** A citation as the chat writes it. */
export function cite(e: Evidence): string {
  return `[source: ${e.source} "${e.quote.replaceAll('"', "'")}"]`;
}

/** The scope maps of the courses this space sees, for the agent's prompt; null without courses. */
export function promptSection(visible: Visible): string | null {
  const parts: string[] = [];
  for (const seen of visible.courses) {
    const kept = cached(visible, seen, null);
    if (!kept) {
      parts.push(
        `## ${seen.state.name}\n\nNot mapped yet: Phaethon hasn't checked what this course's exams cover. Don't guess an exam's coverage; say where you looked (announcements, syllabus) and cite it.`,
      );
      continue;
    }
    const [map, fresh] = kept;
    let s = `## ${map.name}${fresh ? "" : " (the course has changed since this was mapped)"}\n\nTopics, in the order taught:`;
    for (const t of map.topics.filter((t) => !t.reference)) s += `\n- ${t.title}${sectionsSuffix(t)}`;
    const reference = map.topics.filter((t) => t.reference).map((t) => `${t.title}${sectionsSuffix(t)}`);
    if (reference.length) s += `\n\nIn the readings but never assigned, so reference only (not taught, never tested): ${reference.join("; ")}.`;
    if (seen.state.material) {
      const m = summarise(seen.state.material);
      if (m.handwritingPages + m.unreadablePages + m.pictures > 0) s += `\n\nIts files: ${m.lines.join(" ")}`;
    }
    const said = stated(visible, seen);
    for (const e of map.exams) {
      const x = said.find((x) => examKey(x.exam) === examKey(e.title));
      if (x) s += `\n\n${e.title}: the student says it covers: ${x.text} (from the student).`;
      else if (e.known) {
        s += `\n\n${scopeWords(e)}${e.date !== undefined ? ` (on ${e.date})` : ""}. Evidence: ${e.evidence.map(cite).join(" ")}`;
        const out = map.topics.filter((t) => !e.includes.includes(t.id) && !t.reference).map((t) => t.title);
        if (out.length) s += `\nNot on ${e.title}: ${out.join("; ")}.`;
      } else s += `\n\n${e.title}: what it covers wasn't found in the materials. Don't guess; ask the student or point them to the announcements.`;
    }
    for (const x of said.filter((x) => !map.exams.some((e) => examKey(e.title) === examKey(x.exam)))) {
      s += `\n\n${x.exam}: the student says it covers: ${x.text} (from the student).`;
    }
    parts.push(s);
  }
  if (!parts.length) return null;
  return (
    `# What each course teaches, and what its exams cover\n\n${COURSE_ONLY_CHAT}\n\n` +
    "Stay inside these when you advise the user what to study or explain course material: never teach, quiz or recommend a topic, term or notation the course hasn't covered, and never stretch an exam past its scope. " +
    'Cite the course\'s own words for every claim about what a course covers or teaches, as [source: courses/<folder>/<file> "words copied exactly from that file"] (the file\'s path as it is under courses/, for a PDF the PDF\'s own name). ' +
    "Phaethon checks each citation against the file and shows the user whether it was found, so copy the words exactly and never cite what you haven't read. " +
    "A quick check question while you explain is fine; a new practice set, practice test or flashcards is offered with a phaethon-study block instead of written in chat. Reviewing existing quizzes in chat is allowed, including reproducing their original questions and answer choices and explaining completed attempts. For new material, use the block with \"exam\" set when they are for an exam.\n\n" +
    parts.join("\n\n")
  );
}

/** The course a `courses/<folder>` argument names, among what the space sees. */
export function seenCourse(visible: Visible, course: string): Seen {
  let folder = course.trim();
  while (folder.endsWith("/")) folder = folder.slice(0, -1);
  while (folder.startsWith("courses/")) folder = folder.slice("courses/".length);
  const seen = visible.get(folder);
  if (!seen) throw "That course isn’t one this space can see.";
  return seen;
}
