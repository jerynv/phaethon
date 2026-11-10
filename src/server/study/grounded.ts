import { similar, cardFrom, questionFrom, shuffleChoices, strOf, orderQuestion } from "./items.ts";
import * as material from "./material.ts";
import { askJsonSeeing, extractJson, type Model } from "./model.ts";
import { DECK_REPLY, DECK_RULES, GROUNDING_RULES, QUIZ_REPLY, QUIZ_RULES, VERIFY_SYSTEM } from "./prompts.ts";
import { answerText } from "./quiz.ts";
import * as quote from "./quote.ts";
import type { Exam } from "./schedule.ts";
import * as scope from "./scope.ts";
import { isProblemSet, sectionNumbers } from "./scope.ts";
import * as sources from "./sources.ts";
import type { CourseFile, Material } from "./sources.ts";
import { courseOnly, loadExams } from "./store.ts";
import { baseName, byteLen, charLen, cutBytes, isAlnum, isAlpha, isWs, splitBy, stableSort, takeChars } from "./text.ts";
import { progress, type Coverage, type Dropped, type Emit, type Evidence, type ExamScope, type Grounding, type Note, type Picture, type Question, type ScopeMap, type Topic, type UnknownScope } from "./types.ts";
import type { Seen, Visible } from "./visible.ts";

/**
 * Questions and cards made only from what a course teaches, and checked
 * before they are kept (Rust `study::grounded`):
 * 1. Scope: the course's map is built or reused; an exam fixes the topics.
 * 2. Coverage: questions spread over the topics by weight; the material is
 *    those topics' own passages, with homework in scope as the level.
 * 3. Writing: each item names its topic and cites its passages word for word,
 *    and reasons (its explanation) before it commits to an answer.
 * 4. The gate: topic in scope, every quote in the file it names, unknown
 *    words picked out; then an independent judge. "No"/"unsure" drops it.
 * 5. Shortfalls are written again a bounded number of times; what is still
 *    short is delivered short, with the reasons, never padded.
 */

export const ROUNDS = 3;
const CHECK_BATCH = 12;
const AROUND = 700;
const CITES_MAX = 3;
const BUDGET = 100_000;
const HOMEWORK_BUDGET = 12_000;

// ---- Reading cited files -------------------------------------------------------------

type Doc = { label: string; text: string; compact?: ReturnType<typeof quote.compact> };

/** Cited files, read once each through the space's walls. */
export class Library {
  private readonly docs: Doc[];
  private readonly pictured: material.PageRef[] = [];

  constructor(
    private readonly space: string,
    private readonly visible: Visible,
    files: readonly CourseFile[],
  ) {
    this.docs = files.map((f) => ({ label: f.label, text: f.text }));
  }

  shown(pages: readonly material.PageRef[]): void {
    for (const x of pages) if (!this.pictured.some(([l, p]) => l === x[0] && p === x[1])) this.pictured.push([x[0], x[1]]);
  }

  private doc(source: string): Doc {
    const labels = this.docs.map((d) => d.label);
    const l = sources.matchLabel(source, labels);
    if (l !== null) return this.docs.find((d) => d.label === l)!;
    const c = sources.readCited(this.space, this.visible, source);
    const have = this.docs.find((d) => d.label === c.label);
    if (have) return have;
    const d: Doc = { label: c.label, text: c.text };
    this.docs.push(d);
    return d;
  }

  /** The quote found in the file it names: the evidence as kept and the passage around it; throws why not. */
  check(source: string, q: string): [Evidence, string] {
    const why = quote.unusable(q);
    if (why) throw `its quote ${why}`;
    let d: Doc;
    try {
      d = this.doc(source);
    } catch (e) {
      throw `it cites ${typeof e === "string" ? e : (e as Error).message}`;
    }
    d.compact ??= quote.compact(d.text);
    const f = quote.findIn(d.text, d.compact, q);
    if (!f) {
      const shown = this.pictured.filter(([l]) => l === d.label).map(([, p]) => p);
      const page = material.pictureQuote(d.text, shown, q);
      if (page === null) throw `its quote isn’t in ${baseName(d.label)}`;
      const recognised = quote.pageText(d.text, page) ?? "";
      const passage = `[${d.label} p. ${page}, read from the picture of the page; text recognition read it as:] ${takeChars(recognised, 2 * AROUND)}\nQuoted from the picture: «${quote.tidy(q)}»`;
      return [{ source: d.label, quote: quote.tidy(q), at: `p. ${page}`, picture: page }, passage];
    }
    const [before, hit, after] = quote.context(d.text, f, AROUND);
    const at = quote.locate(d.text, f.start, isProblemSet(d.label));
    const ev: Evidence = { source: d.label, quote: quote.tidy(q) };
    if (at !== null) ev.at = at;
    return [ev, `[${d.label}${at !== null ? ` ${at}` : ""}] ${before}«${hit}»${after}`];
  }
}

/** Files that say what a course is (announcements, syllabus, assignment list), not where it teaches. */
export function isLogistics(label: string): boolean {
  const rel = (label.split("/").length >= 3 ? label.split("/").slice(2).join("/") : label).toLowerCase();
  return ["announcements.md", "assignments.md", "syllabus.md", "grades.md"].includes(rel) || baseName(rel).includes("syllabus");
}

// ---- Words the course never uses ---------------------------------------------------------

const COMMON = [
  "which", "following", "true", "false", "statement", "statements", "correct", "incorrect", "select", "apply", "answer", "explain", "about",
  "these", "those", "there", "their", "would", "could", "should", "every", "where", "what", "when", "whose", "given", "suppose", "consider",
  "because", "therefore", "neither", "either", "another", "other", "between", "without", "within", "exactly", "least", "most",
];

/** Words of `text` (LaTeX commands left out) the course never uses, for the judge to weigh. */
export function unknownWords(text: string, vocab: ReadonlySet<string>): string[] {
  let plain = "";
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "\\") {
      while (i + 1 < chars.length && isAlpha(chars[i + 1]!)) i++;
      plain += " ";
    } else plain += chars[i];
  }
  const out: string[] = [];
  for (const raw of splitBy(plain, (c) => !isAlpha(c))) {
    if (charLen(raw) < 4) continue;
    const w = raw.toLowerCase();
    if (COMMON.includes(w) || out.includes(w)) continue;
    const strip = (suf: string) => (w.endsWith(suf) ? w.slice(0, -suf.length) : w);
    let noS = w;
    while (noS.endsWith("s")) noS = noS.slice(0, -1);
    const stems = [w, noS, strip("es"), strip("ed"), strip("ing"), strip("ly")];
    const known = stems.some((s) => byteLen(s) >= 3 && (vocab.has(s) || vocab.has(`${s}s`) || vocab.has(`${s}e`) || vocab.has(`${s}es`)));
    if (!known) out.push(w);
  }
  return out.slice(0, 10);
}

// ---- Material for writing --------------------------------------------------------------

const TITLE_SKIP = ["about", "using", "their", "with", "from", "proofs", "basic", "definitions"];

function topicTerms(t: Topic): string[] {
  const out = t.terms.map((x) => x.toLowerCase()).filter((x) => charLen(x) >= 3);
  for (const w of splitBy(t.title.toLowerCase(), (c) => !isAlnum(c))) {
    if (charLen(w) >= 5 && !out.includes(w) && !TITLE_SKIP.includes(w)) out.push(w);
  }
  return out;
}

const isContents = (p: string): boolean => p.split(". . .").length - 1 >= 5;

function countOf(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** About `len` bytes of `p` around the first place its topic is named, cut at whole words. */
function aroundTerms(p: string, terms: readonly string[], sections: readonly string[], len: number): string {
  if (byteLen(p) <= len) return p;
  const lower = p.toLowerCase();
  const hits = [...sections.map((s) => p.indexOf(`${s} `)), ...terms.map((t) => lower.indexOf(t))].filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  const atBytes = byteLen(p.slice(0, at));
  const startBytes = Math.max(atBytes - Math.floor(len / 4), 0);
  const startStr = cutBytes(p, startBytes).length;
  const rest = p.slice(startStr);
  let s = cutBytes(rest, len);
  const endsEarly = startStr + s.length < p.length;
  if (startStr > 0) {
    const i = [...s].findIndex(isWs);
    if (i >= 0) s = [...s].slice(i + 1).join("");
  }
  if (endsEarly) {
    const cs = [...s];
    let j = -1;
    for (let k = cs.length - 1; k >= 0; k--) if (isWs(cs[k]!)) {
      j = k;
      break;
    }
    if (j >= 0) s = cs.slice(0, j).join("");
  }
  return s;
}

/** Each in-scope topic's best teaching passages, in course order, then homework in scope as the level. */
export function topicMaterial(files: readonly CourseFile[], topics: readonly [Topic, number][], homework: readonly string[]): Material {
  const teaching = files.filter((f) => !isLogistics(f.label)).map((f) => ({ f, parts: sources.chunks(sources.clean(f.text)) }));
  const active = topics.filter(([, n]) => n > 0);
  const picked: [number, number][] = [];
  const out: { label: string; text: string }[] = [];
  let used = 0;
  const room = BUDGET - HOMEWORK_BUDGET;
  const piece = Math.min(Math.max(Math.floor(room / Math.max(active.length, 1)), 1_200), 5_000);
  for (let pass = 0; pass < 3; pass++) {
    for (const [t, n] of active) {
      if (pass >= Math.min(1 + n, 3)) continue;
      const terms = topicTerms(t);
      const sections = sectionNumbers(t.sections);
      let best: [number, number, number] | null = null as [number, number, number] | null;
      for (let fi = 0; fi < teaching.length; fi++) {
        const { f, parts } = teaching[fi]!;
        const hw = isProblemSet(f.label);
        for (let ci = 0; ci < parts.length; ci++) {
          const p = parts[ci]!;
          if (picked.some(([a, b]) => a === fi && b === ci) || isContents(p)) continue;
          const lower = p.toLowerCase();
          let score = terms.reduce((s, x) => s + countOf(lower, x), 0);
          for (const s of sections) if (p.includes(`${s} `)) score += 6;
          if (!hw) score *= 2;
          if (score > 0 && (best === null || score > best[0])) best = [score, fi, ci];
        }
      }
      if (best !== null) {
        const [, fi, ci] = best;
        const text = aroundTerms(teaching[fi]!.parts[ci]!, terms, sections, piece);
        if (used + byteLen(text) > room) continue;
        used += byteLen(text);
        picked.push([fi, ci]);
        out.push({ label: teaching[fi]!.f.label, text });
      }
    }
  }
  const keyed = picked.map((k, i) => ({ k, p: out[i]! })).sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1]);
  let text = "";
  const labels: string[] = [];
  for (const { p } of keyed) {
    text += `<source path="${p.label}">\n${p.text}\n</source>\n\n`;
    if (!labels.includes(p.label)) labels.push(p.label);
  }
  let hwUsed = 0;
  const hwFiles = files.filter((f) => homework.includes(f.label));
  const share = hwFiles.length ? Math.max(Math.floor(HOMEWORK_BUDGET / Math.min(hwFiles.length, 3)), 1_500) : 0;
  for (const f of [...hwFiles].reverse().slice(0, 3)) {
    const sample = sources.sample(sources.clean(f.text), share, []);
    if (hwUsed + byteLen(sample) > HOMEWORK_BUDGET + 500) break;
    hwUsed += byteLen(sample);
    text += `<homework path="${f.label}">\n${sample}\n</homework>\n\n`;
    if (!labels.includes(f.label)) labels.push(f.label);
  }
  const first = labels[0];
  const course = first?.startsWith("courses/") && first.slice(8).includes("/") ? first.slice(8).split("/")[0]! : null;
  return { text: text.trimEnd(), labels, course };
}

// ---- The scope a request is made against -------------------------------------------------

export type Scoped = { map: ScopeMap | null; exam: ExamScope | null; plan: [Topic, number][]; outside: Topic[]; notes: string[] };

export class ScopeError {
  constructor(
    readonly message: string,
    readonly unknown: UnknownScope | null,
  ) {}
}

/** Focus words, each with one trailing "s" taken off ("graphs" → "graph", but "class" stays). */
function focusWords(focus: string): string[] {
  return sources
    .focusTerms(focus)
    .map((w) => (w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .filter((w) => byteLen(w) >= 3);
}

function topicMatches(t: Topic, words: readonly string[]): boolean {
  const hay = `${t.title} ${t.terms.join(" ")} ${t.sections ?? ""}`.toLowerCase();
  return words.some((w) => hay.includes(w));
}

export async function scoped(
  visible: Visible,
  seen: Seen,
  files: readonly CourseFile[],
  exams: readonly Exam[],
  exam: string | null,
  focus: string | null,
  count: number,
  model: Model,
  emit: Emit,
  now: number,
): Promise<Scoped> {
  const kept = scope.cached(visible, seen, files);
  let map: ScopeMap;
  if (kept && kept[1]) map = kept[0];
  else {
    emit(progress("mapping", 0, 1));
    try {
      map = await scope.build(visible, seen, exams, model, now, (d, t) => emit(progress("mapping", d, t)));
    } catch (e) {
      throw new ScopeError(typeof e === "string" ? e : (e as Error).message, null);
    }
  }
  const notes: string[] = [];
  const wanted = exam && exam.trim() !== "" ? exam : focus ? scope.namedExam(map.exams, focus) : null;
  let examScope: ExamScope | null = null;
  if (wanted) {
    try {
      examScope = await scope.examScope(visible, seen, map, wanted, model);
    } catch (e) {
      throw new ScopeError(typeof e === "string" ? e : (e as Error).message, null);
    }
    if (!examScope) {
      const title = scope.findExam(map.exams, wanted)?.title ?? wanted;
      throw new ScopeError(
        `I couldn’t find what ${title} covers in your ${seen.state.name} materials, so I haven’t made anything: I won’t guess. Tell me what it covers (for example “through HW 6, not graphs”) and I’ll make it from that.`,
        { course: `courses/${seen.state.folder}`, courseName: seen.state.name, exam: title },
      );
    }
  }
  let topics = scope.inScope(map, examScope);
  if (!topics.length) {
    throw new ScopeError(`None of ${seen.state.name}’s mapped topics are inside ${examScope?.title ?? "the scope"}. Tell me what it covers, or map the course again.`, null);
  }
  if (focus && focus.trim() !== "") {
    const words = focusWords(focus).filter((w) => scope.namedExam(map.exams, w) === null && !["test", "exam", "quiz", "practice", "midterm", "final"].includes(w));
    if (words.length) {
      const narrowed = topics.filter((t) => topicMatches(t, words));
      if (!narrowed.length) {
        notes.push(
          map.topics.some((t) => topicMatches(t, words))
            ? `“${focus}” is outside ${examScope?.title ?? "what you chose"}, so the questions cover everything in it instead.`
            : `I couldn’t find “${focus}” among the topics ${map.name} teaches, so the questions cover ${examScope ? `everything in ${examScope.title}` : "all of them"} instead.`,
        );
      } else topics = narrowed;
    }
  }
  const alloc = scope.allocate(topics, count);
  const plan: [Topic, number][] = topics.map((t, i) => [t, alloc[i]![1]]);
  const inside = new Set(plan.map(([t]) => t.id));
  const outside = map.topics.filter((t) => !inside.has(t.id));
  return { map, exam: examScope, plan, outside, notes };
}

// ---- Writing and checking ----------------------------------------------------------------

export type Want = { kind: "quiz"; kinds: readonly string[]; difficulty: string } | { kind: "deck"; existing: readonly string[] };

export type Item = { kind: "q"; q: Question } | { kind: "n"; n: Note };

const itemText = (i: Item): string => (i.kind === "q" ? i.q.prompt : i.n.front);

function itemWhole(i: Item): string {
  if (i.kind === "n") return `Card front: ${i.n.front}\nCard back: ${i.n.back}`;
  const q = i.q;
  let s = `Question (${q.kind}): ${q.prompt}`;
  if (q.choices && q.kind !== "truefalse") s += `\nChoices: ${q.choices.join(" | ")}`;
  s += `\nMarked answer: ${answerText(q.answer)}`;
  if (q.accept) s += ` (also accepted: ${q.accept.join(", ")})`;
  s += `\nExplanation: ${q.explanation}`;
  if (q.misconceptions) {
    s += `\nWrong choices, and the mistake each stands for: ${Object.entries(q.misconceptions).map(([c, m]) => `${c} — ${m}`).join(" | ")}`;
  }
  return s;
}

function itemWords(i: Item): string {
  if (i.kind === "n") return `${i.n.front} ${i.n.back}`;
  const q = i.q;
  return `${q.prompt} ${(q.choices ?? []).join(" ")} ${answerText(q.answer)} ${(q.accept ?? []).join(" ")} ${q.explanation}`;
}

type Candidate = { item: Item; topic: string | null; cites: Evidence[]; passages: string[]; unknown: string[] };

const withSections = (t: { title: string; sections?: string }) => `${t.title}${t.sections !== undefined ? ` (${t.sections})` : ""}`;

function notInScope(s: Scoped): string[] {
  return [...s.outside.map((t) => t.title), ...(s.exam?.excludedWords ?? [])];
}

function scopeBlock(s: Scoped, course: string): string {
  let out = "<scope>\n";
  if (s.exam) out += `Exam: ${scope.scopeWords(s.exam)}\n`;
  else if (s.map) out += `No particular exam: anything ${course} has taught.\n`;
  else out += "The chosen material only.\n";
  if (s.plan.length) {
    out += "Topics in scope:\n";
    for (const [t] of s.plan) out += `- ${withSections(t)}\n`;
  }
  const not = notInScope(s);
  if (not.length) out += `Not in scope: ${not.join("; ")}\n`;
  return out + "</scope>";
}

/** The course's notation whose evidence is still found in its files (through this space's walls). */
function taughtNotation(map: ScopeMap | null, library: Library): string {
  if (!map) return "";
  const out: string[] = [];
  for (const n of map.notation) {
    let found: Evidence | null = null;
    for (const e of n.evidence) {
      if (e.source === scope.FROM_YOU) continue;
      try {
        found = library.check(e.source, e.quote)[0];
        break;
      } catch {
        // try the next passage
      }
    }
    if (found && n.symbol.trim() !== "") out.push(`${n.symbol.trim()}: ${n.meaning.trim()} ${scope.cite(found)}`);
  }
  return out.join("\n");
}

function writeRequest(
  s: Scoped,
  want: Want,
  mat: Material,
  need: readonly [Topic, number][],
  kept: readonly string[],
  refused: readonly Dropped[],
  context: string | null,
  extra: string,
  notation: string,
): string {
  const noun = want.kind === "quiz" ? "questions" : "flashcards";
  const total = need.reduce((a, [, n]) => a + n, 0);
  let u = want.kind === "quiz" ? `Write ${total} practice questions. Kinds: ${want.kinds.join(", ")}. Difficulty: ${want.difficulty}.\n\n` : `Write ${total} flashcards.\n\n`;
  if (need.some(([t]) => t.id !== "")) {
    u += "<topics>\n";
    for (const [t, n] of need) u += `- ${t.id}: ${withSections(t)} — ${n} ${noun}\n`;
    u += "</topics>\n\n";
  }
  const not = notInScope(s);
  if (not.length) u += `<not_in_scope>\n${not.join("\n")}\n</not_in_scope>\n\n`;
  if (notation) u += `<notation>\n${notation}\n</notation>\n\n`;
  u += `<material>\n${mat.text}\n</material>`;
  if (kept.length) u += `\n\nAlready written (don't repeat these):\n${kept.map((k) => `- ${k}`).join("\n")}`;
  if (refused.length) {
    u += `\n\nThese were thrown away by the check; don't write anything like them again:\n${[...refused]
      .reverse()
      .slice(0, 12)
      .map((d) => `- ${takeChars(d.text, 200)} (${d.why})`)
      .join("\n")}`;
  }
  const c = context?.trim();
  if (c) {
    u += `\n\n<discussion>\n${c}\n</discussion>\n\nThe student asked for these ${noun} in that conversation. Keep to what was promised there only as far as the scope and the material allow: the discussion is not course material.`;
  }
  return u + extra;
}

/** The mechanical gate over one reply: topic in scope, every quote found, well formed. */
function sortReply(
  v: unknown,
  want: Want,
  s: Scoped,
  mat: Material,
  library: Library,
  vocab: ReadonlySet<string>,
  dropped: Dropped[],
  droppedTopics: (string | null)[],
): Candidate[] {
  const key = want.kind === "quiz" ? "questions" : "cards";
  const fromKey = (v as Record<string, unknown> | null)?.[key];
  const list: unknown[] = Array.isArray(fromKey) ? fromKey : Array.isArray(v) ? v : [];
  const ids = new Map(s.plan.map(([t]) => [t.id, t] as const));
  const out: Candidate[] = [];
  list.forEach((raw, i) => {
    const n = i + 1;
    const shown = strOf(raw, key === "questions" ? "prompt" : "front");
    const topicId = strOf(raw, "topic");
    const drop = (why: string) => {
      dropped.push({ text: shown, why });
      droppedTopics.push(ids.has(topicId) ? topicId : null);
    };
    let topic: Topic | null = null;
    if (s.plan.length) {
      const t = ids.get(topicId);
      if (!t) {
        const outOf = s.outside.find((x) => x.id === topicId);
        drop(outOf ? `its topic, ${outOf.title}, isn’t in scope` : "it doesn’t name a topic in scope");
        return;
      }
      topic = t;
    }
    const cites: Evidence[] = [];
    const passages: string[] = [];
    const c0 = (raw as Record<string, unknown> | null)?.citations;
    const citeList = Array.isArray(c0) ? c0.slice(0, CITES_MAX) : c0 && typeof c0 === "object" ? [c0] : [];
    for (const c of citeList) {
      try {
        const [ev, passage] = library.check(strOf(c, "source"), strOf(c, "quote"));
        if (!cites.some((x) => x.quote === ev.quote)) {
          cites.push(ev);
          passages.push(passage);
        }
      } catch (e) {
        drop(typeof e === "string" ? e : (e as Error).message);
        return;
      }
    }
    if (!cites.length) {
      drop("it cites no passage");
      return;
    }
    const source = cites[0]!.source;
    let item: Item;
    try {
      if (want.kind === "quiz") item = { kind: "q", q: questionFrom(raw, n, mat, want.kinds, source) };
      else {
        const note = cardFrom(raw, n, mat, source);
        note.quote = cites[0]!.quote;
        if (cites[0]!.picture !== undefined) note.picture = cites[0]!.picture;
        item = { kind: "n", n: note };
      }
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      drop(msg.replace(new RegExp(`^(question|card) ${n}:? `), ""));
      return;
    }
    out.push({ item, topic: topic?.id ?? null, cites, passages, unknown: unknownWords(itemWords(item), vocab) });
  });
  return out;
}

type Verdicts = Map<string, [string, string, boolean]>;

function validateVerdicts(v: unknown): Verdicts {
  const list = (v as Record<string, unknown> | null)?.verdicts;
  if (!Array.isArray(list)) throw 'expected an object with a "verdicts" array';
  const got: Verdicts = new Map();
  for (const x of list) {
    const id = strOf(x, "id");
    const verdict = strOf(x, "verdict").toLowerCase();
    if (!["yes", "no", "unsure"].includes(verdict)) throw `the verdict for ${id} must be yes, no or unsure`;
    const ok = (x as Record<string, unknown> | null)?.answerOk;
    if (typeof ok !== "boolean") throw `answerOk for ${id} must be a boolean`;
    got.set(id, [verdict, strOf(x, "missing"), ok]);
  }
  if (!got.size) throw "there were no verdicts";
  return got;
}

/** The judge's reason to drop an item, or null to keep it. */
export function verdictWhy(v: [string, string, boolean] | undefined): string | null {
  if (!v) return "the check gave no verdict on it";
  const [verdict, missing, ok] = v;
  if (verdict === "yes") return ok ? null : "its answer isn’t right by the notes";
  if (missing === "") return verdict === "no" ? "the check found it isn’t taught in the passages it cites" : "the check couldn’t confirm it is taught in your notes";
  return `${verdict === "no" ? "not taught in your notes or not in scope" : "couldn’t be confirmed"}: ${takeChars(missing, 160)}`;
}

/** Exported for tests: the judge's answer for one batch. */
export async function askVerdicts(model: Model, user: string, pictures: Picture[]): Promise<Verdicts> {
  return askJsonSeeing(model, courseOnly(VERIFY_SYSTEM), user, pictures, validateVerdicts);
}

async function verify(
  s: Scoped,
  course: string,
  notation: string,
  cands: readonly Candidate[],
  model: Model,
  picturesOf: (pages: material.PageRef[], max: number) => Picture[],
  emit: Emit,
  keptSoFar: number,
  droppedSoFar: number,
): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  const titles = new Map(s.plan.map(([t]) => [t.id, withSections(t)] as const));
  let block = scopeBlock(s, course);
  if (notation) block += `\n\n<course_notation>\n${notation}\n</course_notation>`;
  let kept = keptSoFar;
  let dropped = droppedSoFar;
  for (let b = 0; b * CHECK_BATCH < cands.length; b++) {
    const batch = cands.slice(b * CHECK_BATCH, (b + 1) * CHECK_BATCH);
    emit({ type: "progress", step: "checking", done: b * CHECK_BATCH, total: cands.length, kept, dropped });
    let u = `${block}\n\n`;
    batch.forEach((c, i) => {
      u += `<item id="i${i + 1}">\n`;
      const t = c.topic !== null ? titles.get(c.topic) : undefined;
      if (t) u += `Claimed topic: ${t}\n`;
      u += itemWhole(c.item);
      u += "\n<cited>\n";
      for (const p of c.passages) u += `${p}\n\n`;
      u += "</cited>\n";
      if (c.unknown.length) u += `Words in it that appear nowhere in the course's materials: ${c.unknown.join(", ")}\n`;
      u += "</item>\n\n";
    });
    const read: material.PageRef[] = batch.flatMap((c) => c.cites.filter((e) => e.picture !== undefined).map((e) => [e.source, e.picture!] as material.PageRef));
    const pictures = picturesOf(material.roundRobin([read], material.CHECK_PICTURES), material.CHECK_PICTURES);
    u += material.picturesNote(pictures);
    let verdicts: Verdicts;
    try {
      verdicts = await askVerdicts(model, u, pictures);
    } catch (e) {
      throw `The questions couldn’t be checked against your notes, so nothing was saved: ${typeof e === "string" ? e : (e as Error).message}`;
    }
    batch.forEach((_, i) => {
      const why = verdictWhy(verdicts.get(`i${i + 1}`));
      if (why === null) kept++;
      else dropped++;
      out.push(why);
    });
  }
  emit({ type: "progress", step: "checking", done: cands.length, total: cands.length, kept, dropped });
  return out;
}

export type Made = { title: string | null; items: Item[]; grounding: Grounding; material: Material };

export type Ask = { count: number; exam: string | null; focus: string | null; context: string | null; extra: string };

function titleOf(v: unknown): string | null {
  const t = strOf(v, "title");
  return t === "" ? null : t;
}

/**
 * Questions of a quiz, interleaved: one from each topic in course order, then
 * the next from each, so a practice set switches between ideas the way an
 * exam does (within a topic they keep the order written, easier first).
 */
export function interleave<T>(items: readonly T[], topicOf: (t: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = topicOf(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(it);
  }
  const lists = [...groups.values()];
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round++) for (const l of lists) if (round < l.length) out.push(l[round]!);
  return out;
}

export async function make(space: string, visible: Visible, inputs: readonly string[], want: Want, ask: Ask, model: Model, emit: Emit, now: number): Promise<Made> {
  const seen = sources.courseOf(space, visible, [...inputs]);
  const files = seen ? sources.courseFiles(visible, seen) : [];
  let s: Scoped;
  let mat: Material;
  let vocabFiles: CourseFile[];
  if (seen && files.length) {
    const exams = loadExams(space);
    try {
      s = await scoped(visible, seen, files, exams, ask.exam, ask.focus, ask.count, model, emit, now);
    } catch (e) {
      if (e instanceof ScopeError) {
        if (e.unknown) emit({ type: "needsScope", ...e.unknown });
        throw e.message;
      }
      throw e;
    }
    emit(progress("reading", 0, 1));
    const homework =
      s.exam && s.exam.homework.length ? s.exam.homework : files.filter((f) => isProblemSet(f.label) && !f.label.toLowerCase().includes("review")).map((f) => f.label);
    mat = topicMaterial(files, s.plan, homework);
    if (mat.text.trim() === "") throw `I couldn’t find passages in ${seen.state.name} that teach the topics in scope, so nothing was made.`;
    vocabFiles = files;
  } else {
    emit(progress("reading", 0, 1));
    mat = sources.gather(space, visible, [...inputs], ask.focus, sources.BUDGET);
    s = { map: null, exam: null, plan: [], outside: [], notes: [] };
    vocabFiles = [];
    for (const l of mat.labels) {
      try {
        const c = sources.readCited(space, visible, l);
        vocabFiles.push({ label: c.label, sub: "", text: c.text, size: 0, modified: 0 });
      } catch {
        // unreadable now: skipped
      }
    }
  }
  emit(progress("reading", 1, 1));
  const library = new Library(space, visible, vocabFiles);
  const vocab = new Set<string>();
  for (const f of vocabFiles) sources.wordsOf(f.text, vocab);
  const courseName = seen ? seen.state.name : "your material";
  const notation = taughtNotation(s.map, library);
  const system = courseOnly(want.kind === "quiz" ? `${QUIZ_RULES}\n\n${GROUNDING_RULES}\n\n${QUIZ_REPLY}` : `${DECK_RULES}\n\n${GROUNDING_RULES}\n\n${DECK_REPLY}`);
  const picturesOf = (pages: material.PageRef[], max: number): Picture[] => {
    if (!seen || !model.showsPictures() || !pages.length) return [];
    const pics = material.pictures(visible, seen, pages, max);
    library.shown(pages.filter(([l, p]) => pics.some((x) => x.label === `${l}, page ${p}` || x.label === l)));
    return pics;
  };
  const writingPictures = seen ? picturesOf(material.pagesOfPassages(seen, vocabFiles, mat.text, material.WRITE_PICTURES), material.WRITE_PICTURES) : [];
  const existing = want.kind === "deck" ? [...want.existing] : [];
  const target: [Topic, number][] = s.plan.length ? s.plan : [[{ id: "", title: "", terms: [], weight: 1.0, homework: [], evidence: [] }, ask.count]];
  const kept: Candidate[] = [];
  const dropped: Dropped[] = [];
  const droppedTopics: (string | null)[] = [];
  let title: string | null = null;
  const seed = { value: BigInt(now) | 1n };
  for (let round = 0; round < ROUNDS; round++) {
    const have = (id: string) => kept.filter((c) => (c.topic ?? "") === id).length;
    const need: [Topic, number][] = target.map(([t, n]) => [t, Math.max(n - have(t.id), 0)] as [Topic, number]).filter(([, n]) => n > 0);
    if (!need.length) break;
    if (round === 0) {
      const extra = Math.max(Math.floor(ask.count / 4), 1);
      const byWeight = stableSort(
        need.map((_, i) => i),
        (a, b) => need[b]![0].weight - need[a]![0].weight,
      );
      for (let k = 0; k < extra; k++) need[byWeight[k % byWeight.length]!]![1]++;
    }
    emit(progress("making", round, ROUNDS));
    const keptTexts = [...kept.map((c) => itemText(c.item)), ...existing];
    const user = writeRequest(s, want, mat, need, keptTexts, dropped, ask.context, ask.extra, notation) + material.picturesNote(writingPictures);
    let reply: string;
    try {
      reply = await model.completeSeeing(system, user, writingPictures);
    } catch (e) {
      if (!kept.length) throw e;
      dropped.push({ text: "", why: `writing more stopped: ${typeof e === "string" ? e : (e as Error).message}` });
      droppedTopics.push(null);
      break;
    }
    const v = extractJson(reply);
    if (v === undefined) {
      if (round + 1 === ROUNDS && !kept.length) throw "The model’s answer had nothing usable in it, so nothing was saved. Try again.";
      continue;
    }
    title ??= titleOf(v);
    const cands = sortReply(v, want, s, mat, library, vocab, dropped, droppedTopics);
    const fresh: Candidate[] = [];
    for (const c of cands) {
      const t = itemText(c.item);
      if ([...kept, ...fresh].some((k) => similar(itemText(k.item), t)) || existing.some((e) => similar(e, t))) continue;
      fresh.push(c);
    }
    if (!fresh.length) continue;
    let verdicts: (string | null)[];
    try {
      verdicts = await verify(s, courseName, notation, fresh, model, picturesOf, emit, kept.length, dropped.length);
    } catch (e) {
      // A later round's check failing keeps what already passed.
      if (!kept.length) throw e;
      dropped.push({ text: "", why: `checking more stopped: ${typeof e === "string" ? e : (e as Error).message}` });
      droppedTopics.push(null);
      break;
    }
    fresh.forEach((c, i) => {
      const why = verdicts[i] ?? null;
      if (why === null) kept.push(c);
      else {
        dropped.push({ text: itemText(c.item), why });
        droppedTopics.push(c.topic);
      }
    });
  }
  // Each topic's share; extras fill topics that fell short, heaviest first.
  const chosen: number[] = [];
  for (const [t, n] of target) {
    const mine = kept.map((_, i) => i).filter((i) => (kept[i]!.topic ?? "") === t.id).slice(0, n);
    chosen.push(...mine);
  }
  if (chosen.length < ask.count) {
    const weight = (i: number) => target.find(([t]) => t.id === kept[i]!.topic)?.[0].weight ?? 0;
    const spare = stableSort(
      kept.map((_, i) => i).filter((i) => !chosen.includes(i)),
      (a, b) => weight(b) - weight(a),
    );
    chosen.push(...spare.slice(0, ask.count - chosen.length));
  }
  const order = new Map(target.map(([t], i) => [t.id, i] as const));
  chosen.sort((a, b) => (order.get(kept[a]!.topic ?? "") ?? 0) - (order.get(kept[b]!.topic ?? "") ?? 0) || a - b);
  const finalOrder = want.kind === "quiz" ? interleave(chosen, (i) => kept[i]!.topic ?? "") : chosen;
  const topicLabel = new Map(target.filter(([t]) => t.id !== "").map(([t]) => [t.id, withSections(t)] as const));
  const items: Item[] = [];
  const perTopic = new Map<string, number>();
  for (const i of finalOrder) {
    const c = kept[i]!;
    perTopic.set(c.topic ?? "", (perTopic.get(c.topic ?? "") ?? 0) + 1);
    if (c.item.kind === "q") {
      const q: Question = { ...c.item.q, id: `q${items.length + 1}` };
      const label = c.topic !== null ? topicLabel.get(c.topic) : undefined;
      if (label !== undefined) q.topic = label;
      else delete q.topic;
      q.citations = c.cites;
      if (q.choices) q.choices = [...q.choices];
      shuffleChoices(q, seed);
      items.push({ kind: "q", q: orderQuestion(q) });
    } else items.push({ kind: "n", n: { ...c.item.n } });
  }
  if (!items.length) {
    const why = dropped.filter((d) => d.why !== "").slice(0, 3).map((d) => d.why);
    throw `Nothing passed the check against your notes, so nothing was saved${why.length ? ` (${why.join("; ")})` : ""}. Try a different focus, or check the course was imported whole.`;
  }
  const [one, many] = want.kind === "quiz" ? ["question", "questions"] : ["card", "cards"];
  const notes = [...s.notes];
  if (items.length < ask.count) {
    notes.push(
      `Only ${items.length} of the ${ask.count} ${many} you asked for passed the check against your notes, so there are ${items.length}. The rest weren’t padded with others: ${dropped.length} were dropped, mostly because ${mostCommonWhy(dropped)}.`,
    );
  }
  const coverage: Coverage[] = s.plan.map(([t, n]) => {
    const count = perTopic.get(t.id) ?? 0;
    const c: Coverage = { topic: t.title, count };
    if (t.sections !== undefined) c.sections = t.sections;
    if (count === 0) {
      c.why =
        n === 0
          ? `fewer ${many} than topics: one near it in the course, which it leans on more, got it`
          : droppedTopics.some((id, i) => id === t.id && dropped[i]!.why !== "")
            ? `its ${many} didn’t pass the check`
            : `no ${one} on it could be written from your notes`;
    }
    return c;
  });
  const grounding: Grounding = { fromUser: s.exam?.fromUser ?? false, evidence: s.exam?.evidence ?? [], asked: ask.count, kept: items.length, dropped: [], coverage };
  const g: Grounding = {} as Grounding;
  if (s.exam) g.exam = s.exam.title;
  if (s.exam) {
    const words = scope.scopeWords(s.exam);
    const prefix = `${s.exam.title}: `;
    g.scope = words.startsWith(prefix) ? words.slice(prefix.length) : "";
  }
  Object.assign(g, grounding);
  g.dropped = dropped.filter((d) => d.text !== "" || d.why !== "");
  if (notes.length) g.notes = notes;
  return { title, items, grounding: g, material: mat };
}

/** The most common kind of reason things were dropped, in words. */
export function mostCommonWhy(dropped: readonly Dropped[]): string {
  const counts: [string, number][] = [];
  for (const d of dropped) {
    const w = d.why;
    const key =
      w.includes("quote") && w.includes("isn’t in")
        ? "their quotes weren’t in the files they named"
        : w.includes("quote")
          ? "their quotes couldn’t be checked"
          : w.startsWith("it cites")
            ? "they cited files this space can’t read"
            : w.includes("scope")
              ? "they were outside the scope"
              : w.includes("not taught") || w.includes("confirm") || w.includes("check")
                ? "they needed ideas your notes don’t teach"
                : "they weren’t well formed";
    const c = counts.find(([k]) => k === key);
    if (c) c[1]++;
    else counts.push([key, 1]);
  }
  return stableSort(counts, (a, b) => b[1] - a[1])[0]?.[0] ?? "they didn’t pass";
}
