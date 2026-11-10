import fs from "node:fs";
import path from "node:path";
import { lstat, plainFile, writeIn } from "./files.ts";
import { makeDeck, makeQuiz } from "./generate.ts";
import * as material from "./material.ts";
import type { Model } from "./model.ts";
import { STUDY_FENCE } from "./prompt.ts";
import * as scope from "./scope.ts";
import { alert as sightAlert } from "./sight.ts";
import * as sources from "./sources.ts";
import { DECKS, checkPath, loadDeck, loadQuiz } from "./store.ts";
import { asciiLower, byteLen, charLen, fnvParts, isAlnum, parseRustF64, rustLines, squeeze, takeChars } from "./text.ts";
import type { Alert, Emit, Evidence, Grounding, Sight } from "./types.ts";
import type { Visible } from "./visible.ts";

/**
 * Study blocks in chat (Rust `study::chat`): the assistant ends a reply with a
 * ```phaethon-study block describing a quiz or deck; the UI shows it as a
 * button, and pressing it makes the set through the grounded pipeline, once
 * per block (keyed by its origin), with a way to stop it.
 */

export const FENCE = STUDY_FENCE;
const FENCE_MAX = 8192;
const TITLE_MAX = 120;
const FOCUS_MAX = 300;
const SOURCES_MAX = 20;
const SOURCE_MAX = 500;
const QUESTION_MAX = 3000;
const REPLY_MAX = 6000;
const MADE = ".phaethon/study/from-chat.json";
const MADE_KEEP = 500;

export type Kind = "quiz" | "deck";

export type Action = {
  kind: Kind;
  title: string | null;
  focus: string | null;
  count: number;
  kinds: string[];
  difficulty: string;
  sources: string[];
  exam: string | null;
  notes: string[];
};

export type PlanSource = { path: string; name: string };

export type PlanScope = {
  exam: string;
  state: "known" | "unknown" | "unmapped";
  words?: string;
  fromUser: boolean;
  evidence: Evidence[];
  course: string;
  courseName: string;
};

export type Plan = {
  origin: string;
  kind: Kind;
  title?: string;
  focus?: string;
  count: number;
  kinds: string[];
  difficulty: string;
  sources: PlanSource[];
  unknown: string[];
  notes: string[];
  made?: string;
  running: boolean;
  exam?: string;
  scope?: PlanScope;
  material?: Alert;
};

type Obj = Record<string, unknown>;

function textField(v: Obj, keys: string[], max: number, what: string): string | null {
  for (const k of keys) {
    const x = v[k];
    if (x === undefined || x === null) continue;
    if (typeof x !== "string") throw `its ${what} isn’t text`;
    const s = squeeze(x);
    if (charLen(s) > max) throw `its ${what} is too long (over ${max} characters)`;
    return s === "" ? null : s;
  }
  return null;
}

function listField(v: Obj, keys: string[], maxItems: number, what: string): string[] {
  for (const k of keys) {
    const x = v[k];
    if (x === undefined || x === null) continue;
    if (typeof x === "string") {
      const s = x.trim();
      // Fixed: a single string is held to the same length as a list item.
      if (charLen(s) > SOURCE_MAX) throw `one of its ${what} is too long`;
      return s === "" ? [] : [s];
    }
    if (!Array.isArray(x)) throw `its ${what} aren’t a list`;
    if (x.length > maxItems) throw `it lists too many ${what} (over ${maxItems})`;
    const out: string[] = [];
    for (const item of x) {
      if (typeof item !== "string") throw `its ${what} aren’t all text`;
      const s = item.trim();
      if (charLen(s) > SOURCE_MAX) throw `one of its ${what} is too long`;
      if (s !== "" && !out.includes(s)) out.push(s);
    }
    return out;
  }
  return [];
}

const KIND_NAMES: Record<string, string> = {
  choice: "choice",
  multiplechoice: "choice",
  mcq: "choice",
  multi: "multi",
  multiselect: "multi",
  selectall: "multi",
  truefalse: "truefalse",
  tf: "truefalse",
  short: "short",
  shortanswer: "short",
  cloze: "cloze",
  fillin: "cloze",
  fillintheblank: "cloze",
};

/** Reads a block strictly and within bounds; errors are plain-language strings. */
export function parse(block: string): Action {
  if (byteLen(block) > FENCE_MAX) throw "The plan is too long to read.";
  let v: unknown;
  try {
    v = JSON.parse(block.trim());
  } catch {
    v = undefined;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw "The plan isn’t written in a form Phaethon can read.";
  const o = v as Obj;
  const bad = (why: string) => `The plan can’t be used: ${why}.`;
  if (typeof o.kind !== "string") throw bad("it doesn’t say whether it is a quiz or flashcards");
  const k = asciiLower(o.kind.trim());
  const kind: Kind | null = k === "quiz" ? "quiz" : ["deck", "flashcards", "cards"].includes(k) ? "deck" : null;
  if (!kind) throw bad(`“${o.kind.trim()}” isn’t a quiz or flashcards`);
  const [max, dflt, noun] = kind === "quiz" ? [50, 10, "questions"] : [100, 20, "cards"];
  const notes: string[] = [];
  let count: number;
  if (o.count === undefined || o.count === null) count = dflt;
  else {
    const n = typeof o.count === "number" ? o.count : typeof o.count === "string" ? parseRustF64(o.count.trim()) : undefined;
    if (n === undefined || n === null) throw bad("its count isn’t a number");
    if (!Number.isFinite(n) || n < 1 || Math.trunc(n) !== n) throw bad("its count must be a whole number, at least 1");
    count = n;
    if (count > max) {
      notes.push(`At most ${max} ${noun} are made at once, so this makes ${max}.`);
      count = max;
    }
  }
  const title = textField(o, ["title"], TITLE_MAX, "title");
  const focus = textField(o, ["focus", "topic", "topics"], FOCUS_MAX, "focus");
  const srcs = listField(o, ["sources", "source"], SOURCES_MAX, "sources");
  let kinds: string[] = [];
  let difficulty = "exam";
  if (kind === "quiz") {
    for (const raw of listField(o, ["kinds", "questionKinds", "types", "questionTypes"], 10, "kinds of question")) {
      const name = KIND_NAMES[asciiLower(raw).replace(/[-_ /]/g, "")];
      if (!name) notes.push(`“${raw}” isn’t a kind of question Phaethon makes, so it’s left out.`);
      else if (!kinds.includes(name)) kinds.push(name);
    }
    if (!kinds.length) kinds = ["choice", "truefalse", "short"];
    const d = textField(o, ["difficulty", "level"], 20, "difficulty");
    if (d !== null) {
      const dl = asciiLower(d);
      if (dl === "easier" || dl === "easy") difficulty = "easier";
      else if (["exam", "medium", "normal", "mixed"].includes(dl)) difficulty = "exam";
      else if (dl === "harder" || dl === "hard") difficulty = "harder";
      else notes.push(`“${d}” isn’t a difficulty, so it’s at exam level.`);
    }
  }
  const exam = textField(o, ["exam", "test"], 80, "exam");
  return { kind, title, focus, count, kinds, difficulty, sources: srcs, exam, notes };
}

/** One block in one conversation turn: FNV over the squeezed question and block. */
export function origin(question: string, block: string): string {
  return fnvParts(squeeze(question), squeeze(block));
}

// ---- Sources -------------------------------------------------------------------------

function squashName(s: string): string {
  let out = "";
  for (const c of s.toLowerCase()) if (isAlnum(c)) out += c;
  return out;
}

function stripCourses(s: string): string {
  let x = s;
  while (x.startsWith("courses/")) x = x.slice(8);
  return x;
}

function courseByName(list: sources.CourseSource[], raw: string): sources.CourseSource | null {
  let t = raw.trim();
  while (t.endsWith("/")) t = t.slice(0, -1);
  const want = squashName(stripCourses(t));
  if (byteLen(want) < 3) return null;
  const exact = list.find((c) => squashName(stripCourses(c.folder)) === want || squashName(c.name) === want);
  if (exact) return exact;
  const hits = list.filter((c) => squashName(c.name).includes(want) || squashName(c.folder).includes(want) || want.includes(squashName(c.name)));
  return hits.length === 1 ? hits[0]! : null;
}

function canon(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function relative(space: string, visible: Visible, raw: string): string {
  if (!path.isAbsolute(raw)) {
    let r = raw;
    while (r.startsWith("./")) r = r.slice(2);
    return r;
  }
  const c = canon(raw);
  const sc = canon(space);
  const inside = (dir: string) => {
    const rel = path.relative(dir, c);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)) ? rel.split(path.sep).join("/") : null;
  };
  const inSpace = inside(sc);
  if (inSpace !== null) return inSpace;
  for (const seen of visible.courses) {
    const dir = visible.dirOf(seen);
    const rest = dir ? inside(dir) : null;
    if (rest !== null) return rest === "" ? `courses/${seen.state.folder}` : `courses/${seen.state.folder}/${rest}`;
  }
  return raw;
}

function fileNameOf(p: string): string {
  let t = p;
  while (t.endsWith("/")) t = t.slice(0, -1);
  return t.split("/").pop() ?? t;
}

/** The block's sources, each resolved inside what the space sees; the rest named back as unknown. */
export function resolveSources(space: string, visible: Visible, raw: readonly string[]): [PlanSource[], string[]] {
  const list = sources.courses(visible);
  const courseName = (folder: string) => list.find((c) => c.folder === folder)?.name ?? stripCourses(folder);
  const ok: PlanSource[] = [];
  const unknown: string[] = [];
  const push = (s: PlanSource) => {
    if (!ok.some((o) => o.path === s.path)) ok.push(s);
  };
  for (const r of raw) {
    let rel = relative(space, visible, r.trim());
    while (rel.endsWith("/")) rel = rel.slice(0, -1);
    let src: sources.Source | null = null;
    try {
      src = sources.resolve(space, visible, rel);
    } catch {
      src = null;
    }
    if (src?.kind === "courses") push({ path: "courses", name: "all your courses" });
    else if (src?.kind === "course") {
      const folder = `courses/${src.seen.state.folder}`;
      const name = courseName(folder);
      if (src.sub === "") push({ path: folder, name });
      else {
        const p = `${folder}/${src.sub.split("\\").join("/")}`;
        push({ path: p, name: `${fileNameOf(p)} (${name})` });
      }
    } else if (src?.kind === "local" && rel !== "" && rel !== ".") push({ path: rel, name: fileNameOf(rel) });
    else {
      const c = courseByName(list, r);
      if (c) push({ path: c.folder, name: c.name });
      else unknown.push(r.trim());
    }
  }
  if (!ok.length && !unknown.length) {
    if (list.length === 1) ok.push({ path: list[0]!.folder, name: list[0]!.name });
    else if (list.length > 1) ok.push({ path: "courses", name: "all your courses" });
  }
  return [ok, unknown];
}

// ---- What was made, and what is being made ---------------------------------------------

type MadeEntry = { origin: string; path: string; at: number };

/** from-chat.json; `strict` refuses a damaged file instead of reading it as empty. */
function loadMade(space: string, strict: boolean): MadeEntry[] {
  const file = path.join(space, MADE);
  if (!lstat(file)) return [];
  const real = plainFile(space, MADE);
  try {
    if (!real) throw new Error("it isn’t a plain file");
    const v = JSON.parse(fs.readFileSync(real, "utf8")) as { made?: unknown };
    const list = v && typeof v === "object" && !Array.isArray(v) ? (v.made ?? []) : null;
    if (!Array.isArray(list)) throw new Error("it isn’t laid out as Phaethon expects");
    const out: MadeEntry[] = [];
    for (const e of list) {
      const x = e as MadeEntry;
      if (x && typeof x.origin === "string" && typeof x.path === "string" && typeof x.at === "number") out.push({ origin: x.origin, path: x.path, at: x.at });
      else throw new Error("an entry isn’t laid out as Phaethon expects");
    }
    return out;
  } catch (e) {
    if (strict) throw `It was made, but couldn’t be noted: ${MADE} can’t be read (${(e as Error).message}), so it was left as it is.`;
    return [];
  }
}

/** The quiz or deck already made from this block, if it still exists. */
export function made(space: string, originId: string): string | null {
  const entry = [...loadMade(space, false)].reverse().find((e) => e.origin === originId);
  if (!entry) return null;
  let rel: string;
  try {
    rel = checkPath(entry.path, entry.path.startsWith(DECKS) ? "deck" : "quiz");
  } catch {
    return null;
  }
  return plainFile(space, rel) ? rel : null;
}

export function record(space: string, originId: string, p: string, now: number): void {
  const list = loadMade(space, true).filter((e) => e.origin !== originId);
  list.push({ origin: originId, path: p, at: now });
  const kept = list.slice(Math.max(0, list.length - MADE_KEEP));
  try {
    writeIn(space, MADE, JSON.stringify({ made: kept }, null, 2));
  } catch (e) {
    throw `It was made, but couldn’t be noted: ${(e as Error).message}`;
  }
}

type ChatRun = { key: string; abort: AbortController };
const RUNS = new Map<string, ChatRun>();

const runKey = (space: string, originId: string) => `${space}\n${originId}`;

export function claimRun(space: string, originId: string): ChatRun | null {
  const key = runKey(space, originId);
  if (RUNS.has(key)) return null;
  const run = { key, abort: new AbortController() };
  RUNS.set(key, run);
  return run;
}

export function releaseRun(run: ChatRun): void {
  if (RUNS.get(run.key) === run) RUNS.delete(run.key);
}

export function running(space: string, originId: string): boolean {
  return RUNS.has(runKey(space, originId));
}

/** Stops the run making this block, if one runs in this space. */
export function cancel(space: string, originId: string): boolean {
  const run = RUNS.get(runKey(space, originId));
  if (!run) return false;
  run.abort.abort();
  return true;
}

// ---- Planning and making -------------------------------------------------------------------

function planScope(space: string, visible: Visible, srcs: readonly PlanSource[], exam: string): PlanScope | null {
  const seen = sources.courseOf(space, visible, srcs.map((s) => s.path));
  if (!seen) return null;
  const base = (state: PlanScope["state"], words: string, fromUser: boolean, evidence: Evidence[], ex: string): PlanScope => {
    const out: PlanScope = { exam: ex, state, fromUser, evidence, course: `courses/${seen.state.folder}`, courseName: seen.state.name };
    if (words !== "") out.words = words;
    return orderScope(out);
  };
  const said = scope.stated(visible, seen).find((s) => scope.findExam([scope.unknownExam(s.exam)], exam) !== null);
  if (said) return base("known", said.text, true, [{ source: scope.FROM_YOU, quote: said.text }], said.exam);
  const kept = scope.cached(visible, seen, null);
  if (!kept) return base("unmapped", "", false, [], exam);
  const e = scope.findExam(kept[0].exams, exam);
  if (e?.known) {
    const w = scope.scopeWords(e);
    const i = w.indexOf(": ");
    return base("known", i >= 0 ? w.slice(i + 2) : "", false, e.evidence, e.title);
  }
  return base("unknown", "", false, [], e ? e.title : exam);
}

function orderScope(s: PlanScope): PlanScope {
  const o = { exam: s.exam, state: s.state } as PlanScope;
  if (s.words !== undefined) o.words = s.words;
  return Object.assign(o, { fromUser: s.fromUser, evidence: s.evidence, course: s.course, courseName: s.courseName });
}

export function plan(space: string, visible: Visible, block: string, question: string): Plan {
  const a = parse(block);
  const id = origin(question, block);
  const [srcs, unknown] = resolveSources(space, visible, a.sources);
  if (!srcs.length) {
    throw unknown.length
      ? `None of what it names is in this space or its courses: ${unknown.join(", ")}.`
      : "There’s no course material in this space to make it from. Import a course first, or ask about files in this space.";
  }
  const sc = a.exam ? planScope(space, visible, srcs, a.exam) : null;
  const p = { origin: id, kind: a.kind } as Plan;
  if (a.title !== null) p.title = a.title;
  if (a.focus !== null) p.focus = a.focus;
  Object.assign(p, { count: a.count, kinds: a.kinds, difficulty: a.difficulty, sources: srcs, unknown, notes: a.notes });
  const m = made(space, id);
  if (m !== null) p.made = m;
  p.running = running(space, id);
  if (a.exam !== null) p.exam = a.exam;
  if (sc) p.scope = sc;
  return p;
}

/** What a model that can't see pictures would miss in this plan's material. */
export function materialAlert(space: string, visible: Visible, p: Plan, sight: Sight): Alert | null {
  const seen = sources.courseOf(space, visible, p.sources.map((s) => s.path));
  if (!seen) return null;
  const report = material.reportOf(seen);
  if (!report) return null;
  const map = scope.cached(visible, seen, null)?.[0] ?? null;
  const exam = p.exam && map ? scope.findExam(map.exams, p.exam) : null;
  const pages = material.examPages(report, seen.state.folder, map, exam);
  const of = exam?.known ? `${exam.title}’s material` : "this course";
  return sightAlert(pages, of, sight);
}

function cut(s: string, max: number): string {
  const t = s.trim();
  return charLen(t) > max ? `${takeChars(t, max)} […]` : t;
}

/** The reply without its fenced blocks (the study block, code). */
export function prose(reply: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of rustLines(reply)) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join("\n").trim();
}

/** What the student asked and what their assistant promised, for the writer (never as course material). */
export function context(question: string, reply: string): string | null {
  const q = cut(question, QUESTION_MAX);
  const r = cut(prose(reply), REPLY_MAX);
  if (q === "" && r === "") return null;
  return `The student asked:\n${q}\n\nTheir assistant answered, promising this:\n${r}`;
}

/** How many questions or cards an already-made item has (0 if it can't be read now). */
export function countOf(space: string, p: string): number {
  try {
    return p.startsWith(DECKS) ? loadDeck(space, p)[1].notes.length : loadQuiz(space, p)[1].questions.length;
  } catch {
    return 0;
  }
}

/** Makes the plan's quiz or deck (once per origin) and notes it; returns path, count, grounding. */
export async function make(space: string, visible: Visible, p: Plan, question: string, reply: string, model: Model, emit: Emit, now: number): Promise<[string, number, Grounding | null]> {
  const already = made(space, p.origin);
  if (already !== null) return [already, countOf(space, already), null];
  const inputs = p.sources.map((s) => s.path);
  const ctx = context(question, reply);
  const [out, n, g] =
    p.kind === "quiz"
      ? await makeQuiz(space, visible, inputs, { count: p.count, kinds: p.kinds, difficulty: p.difficulty, focus: p.focus ?? null, title: p.title ?? null, context: ctx, exam: p.exam ?? null }, model, emit, now)
      : await makeDeck(space, visible, inputs, { count: p.count, focus: p.focus ?? null, title: p.title ?? null, fromAttempt: null, context: ctx, exam: p.exam ?? null }, model, emit, now);
  record(space, p.origin, out, now);
  return [out, n, g];
}
