import fs from "node:fs";
import path from "node:path";
import * as deck from "./deck.ts";
import { errText, plainDir, plainFile, readLossyCapped, segment, writeIn } from "./files.ts";
import { attemptFromJson, normalize, orderQuiz, quizFromJson } from "./quiz.ts";
import * as schedule from "./schedule.ts";
import type { CardState, Exam, Progress } from "./schedule.ts";
import type { Attempt, Deck, Note, Quiz } from "./types.ts";
import { cmpBytes, isControl, squeeze, takeChars } from "./text.ts";

/**
 * Study files in a space (port of `study/mod.rs`): decks, quizzes, attempts,
 * progress and exams, and the views the renderer shows. `space` is always the
 * canonical space folder.
 */

export const COURSE_ONLY =
  "You are given the student's entire coursework for this course, as Phaethon imported it: its files, syllabus, assignments, announcements and readings (textbooks among them), and what the student has said the course or an exam covers. Base everything only on that. If something isn't in it, don't teach it or test it: say it isn't covered. A textbook or other reading counts as course material only for the chapters and sections the syllabus, assignments or announcements point to; the rest of it is reference only, and is never tested.";

export function courseOnly(rules: string): string {
  return `${COURSE_ONLY}\n\n${rules}`;
}

export const COURSE_ONLY_CHAT =
  "Each course's entire coursework is in courses/<folder>/: its files, syllabus, assignments, announcements and readings (textbooks among them), as Phaethon imported it. Treat courses/ and the vault LMS cache as read-only source material, including in Full access. Save generated study work in this space's study/ folder and personal notes in notes/; never overwrite imported material. With what the user says a course or exam covers, that is everything the course is. When you teach, explain, quiz or advise on a course, base it only on that. If something isn't in it, don't teach it from what you know of the subject: say the course doesn't cover it. A textbook or other reading counts as course material only for the chapters and sections the syllabus, assignments or announcements point to; the rest of it is reference only, never what an exam tests. Pages marked as recognised from handwriting or a scan may have wrong words and symbols: inspect the original page with your image/PDF tools before relying on unclear handwriting or equations, cite its path and page, and ask about any symbol you still cannot read. If a required reading is missing, read the course's readings index for its actual publisher or library URL. Use a web or shell download tool only when one is available and permitted, then inspect the saved file. If a publisher or library sign-in is required or no download tool is available, guide the user to that link and ask them to attach the downloaded PDF. Never claim to have downloaded or read a missing file.";

export const DECKS = "study/decks";
export const QUIZZES = "study/quizzes";
export const EXAMS = "study/exams.json";
export const PROGRESS = ".phaethon/study/progress.json";
export const ATTEMPTS = ".phaethon/study/attempts";
export const FILE_MAX = 4 * 1024 * 1024;
export const SESSION_MAX = 500;
export const SESSION_DEFAULT = 20;

export type Item = "deck" | "quiz" | "attempt";

const FOLDER: Record<Item, string> = { deck: DECKS, quiz: QUIZZES, attempt: ATTEMPTS };
const EXT: Record<Item, string> = { deck: ".md", quiz: ".json", attempt: ".json" };
const NOT_ONE: Record<Item, string> = {
  deck: "That isn’t a deck in this space.",
  quiz: "That isn’t a quiz in this space.",
  attempt: "That isn’t a quiz attempt in this space.",
};

/** `path` as a file directly in `item`'s folder with its extension and a plain name; normalised. */
export function checkPath(p0: string, item: Item): string {
  const p = p0.trim().replaceAll("\\", "/");
  const folder = FOLDER[item];
  const ext = EXT[item];
  const name = p.startsWith(folder) && p.slice(folder.length).startsWith("/") ? p.slice(folder.length + 1) : "";
  const ok =
    name !== "" &&
    !name.includes("/") &&
    !name.startsWith(".") &&
    Buffer.byteLength(name) > ext.length &&
    name.replace(/[A-Z]/g, (c) => c.toLowerCase()).endsWith(ext) &&
    ![...name].some((c) => isControl(c) || ':*?"<>|'.includes(c));
  if (!ok) throw NOT_ONE[item];
  return p;
}

/** The file, at most 4 MiB, lossy UTF-8. */
export function readCapped(file: string): string {
  let text: string | null;
  try {
    text = readLossyCapped(file, FILE_MAX);
  } catch (e) {
    throw `It couldn’t be read: ${errText(e)}`;
  }
  if (text === null) throw "It’s too big to open here (over 4 MB).";
  return text;
}

function modifiedMs(file: string): number {
  try {
    return Math.floor(fs.statSync(file).mtimeMs);
  } catch {
    return 0;
  }
}

/** The names (not paths) of `item`'s files, sorted by lowercase name. */
export function list(space: string, item: Item): string[] {
  const dir = plainDir(space, FOLDER[item]);
  if (!dir) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = names.filter((n) => {
    try {
      if (!fs.lstatSync(path.join(dir, n)).isFile()) return false;
      checkPath(`${FOLDER[item]}/${n}`, item);
      return true;
    } catch {
      return false;
    }
  });
  return out
    .map((n, i) => [n, n.toLowerCase(), i] as const)
    .sort((a, b) => cmpBytes(a[1], b[1]) || a[2] - b[2])
    .map(([n]) => n);
}

/** A name for `title` in `item`'s folder no file uses yet (case-insensitive): `Title.md`, `Title (2).md`… */
export function freePath(space: string, item: Item, title: string): string {
  const taken = new Set(list(space, item).map((n) => n.toLowerCase()));
  const ext = EXT[item];
  let stem = segment(title);
  if (stem.toLowerCase().endsWith(ext)) stem = stem.slice(0, stem.length - ext.length);
  stem = takeChars(stem, 90);
  if (stem.trim() === "") stem = "Untitled";
  let name = `${stem}${ext}`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
  return `${FOLDER[item]}/${name}`;
}

function writeFile(space: string, rel: string, text: string): void {
  try {
    writeIn(space, rel, text);
  } catch (e) {
    throw `It couldn’t be saved: ${errText(e)}`;
  }
}

/** The last path segment without its last extension. */
export function fileTitle(rel: string): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const i = name.lastIndexOf(".");
  return i < 0 ? name : name.slice(0, i);
}

// ---- Reading ----------------------------------------------------------------------

export function loadDeck(space: string, p: string): [string, Deck] {
  const rel = checkPath(p, "deck");
  const file = plainFile(space, rel);
  if (!file) throw "That deck isn’t in this space any more.";
  return [rel, deck.parse(readCapped(file), fileTitle(rel))];
}

export function loadQuiz(space: string, p: string): [string, Quiz] {
  const rel = checkPath(p, "quiz");
  const file = plainFile(space, rel);
  if (!file) throw "That quiz isn’t in this space any more.";
  const text = readCapped(file);
  let q: Quiz;
  try {
    q = quizFromJson(JSON.parse(text));
  } catch (e) {
    throw `This quiz file can’t be read (${errText(e)}). Fix or delete ${rel}.`;
  }
  try {
    normalize(q);
  } catch (e) {
    throw `This quiz file has a problem: ${errText(e)} Fix or delete ${rel}.`;
  }
  return [rel, q];
}

export function loadAttempt(space: string, p: string): Attempt {
  const rel = checkPath(p, "attempt");
  const file = plainFile(space, rel);
  if (!file) throw "That quiz attempt isn’t in this space any more.";
  const text = readCapped(file);
  try {
    return attemptFromJson(JSON.parse(text));
  } catch (e) {
    throw `That quiz attempt can’t be read: ${errText(e)}`;
  }
}

/** Every attempt file that loads, in list order, with the file it was read from. */
function attemptFiles(space: string): [string, Attempt][] {
  const out: [string, Attempt][] = [];
  for (const n of list(space, "attempt")) {
    const rel = `${ATTEMPTS}/${n}`;
    try {
      out.push([rel, loadAttempt(space, rel)]);
    } catch {
      // skipped
    }
  }
  return out;
}

export function attempts(space: string): Attempt[] {
  return attemptFiles(space).map(([, a]) => a);
}

function emptyProgress(): Progress {
  return { version: 0, decks: {}, days: [] };
}

function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}

function cardStateFrom(v: unknown): CardState | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const last = num(o.last, 0);
  const history = Array.isArray(o.history) ? o.history.filter((h): h is number => typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 255) : [];
  return {
    reps: num(o.reps, 0),
    lapses: num(o.lapses, 0),
    ease: num(o.ease, schedule.EASE_START),
    interval: num(o.interval, 0),
    due: num(o.due, last),
    last,
    history,
  };
}

function parseProgress(text: string): Progress {
  const v = JSON.parse(text) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("it isn’t a JSON object");
  const o = v as Record<string, unknown>;
  const p = emptyProgress();
  p.version = num(o.version, 0);
  if (o.decks !== undefined && o.decks !== null) {
    if (typeof o.decks !== "object" || Array.isArray(o.decks)) throw new Error("its decks aren’t an object");
    for (const [d, states] of Object.entries(o.decks as Record<string, unknown>)) {
      if (!states || typeof states !== "object" || Array.isArray(states)) throw new Error(`the cards of ${d} aren’t an object`);
      const m: Record<string, CardState> = {};
      for (const [id, s] of Object.entries(states as Record<string, unknown>)) {
        const st = cardStateFrom(s);
        if (!st) throw new Error(`card ${id} isn’t an object`);
        m[id] = st;
      }
      p.decks[d] = m;
    }
  }
  if (o.days !== undefined && o.days !== null) {
    if (!Array.isArray(o.days)) throw new Error("its days aren’t a list");
    p.days = [...new Set(o.days.filter((x): x is number => typeof x === "number" && Number.isInteger(x)))].sort((a, b) => a - b);
  }
  return p;
}

/**
 * Progress for writing. A missing (or linked, or non-file) progress.json is
 * empty; one that exists but can't be read throws, so nothing overwrites it.
 */
export function loadProgress(space: string): Progress {
  const file = plainFile(space, PROGRESS);
  if (!file) return emptyProgress();
  try {
    return parseProgress(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw `Your progress couldn’t be read (${errText(e)}). Fix or remove ${PROGRESS}.`;
  }
}

/** Progress for views: anything unreadable shows as no progress (the file is left alone). */
function viewProgress(space: string): Progress {
  try {
    return loadProgress(space);
  } catch {
    return emptyProgress();
  }
}

function sortedObject<T>(o: Record<string, T>, f: (v: T) => unknown = (v) => v): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort(cmpBytes)) out[k] = f(o[k]!);
  return out;
}

export function saveProgress(space: string, p: Progress): void {
  const out = {
    version: 1,
    decks: sortedObject(p.decks, (states) =>
      sortedObject(states, (s) => ({ reps: s.reps, lapses: s.lapses, ease: s.ease, interval: s.interval, due: s.due, last: s.last, history: s.history })),
    ),
    days: [...new Set(p.days)].sort((a, b) => a - b),
  };
  try {
    writeIn(space, PROGRESS, JSON.stringify(out));
  } catch (e) {
    throw `Your progress couldn’t be saved: ${errText(e)}`;
  }
}

function examFrom(v: unknown): Exam | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.date !== "string") return null;
  if (o.title !== undefined && typeof o.title !== "string") return null;
  if (o.course !== undefined && o.course !== null && typeof o.course !== "string") return null;
  const e: Exam = { title: typeof o.title === "string" ? o.title : "", date: o.date };
  if (typeof o.course === "string") e.course = o.course;
  return e;
}

/** Exams from `study/exams.json` (a list, or `{"exams": [...]}`), each entry read on its own. */
export function loadExams(space: string): Exam[] {
  const file = plainFile(space, EXAMS);
  if (!file) return [];
  let v: unknown;
  try {
    v = JSON.parse(readCapped(file));
  } catch {
    return [];
  }
  const items = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { exams?: unknown }).exams) ? (v as { exams: unknown[] }).exams : [];
  return items.map(examFrom).filter((e): e is Exam => e !== null);
}

// ---- Views (the IPC contract) -------------------------------------------------------

export type DeckSummary = { path: string; title: string; course?: string; cards: number; due: number; new: number; mastery: number; updated: number };
export type QuizSummary = { path: string; title: string; course?: string; questions: number; lastScore?: number; lastTaken?: number };
export type Overview = { decks: DeckSummary[]; quizzes: QuizSummary[]; due: number; streakDays: number };
export type Card = {
  id: string;
  kind: deck.Kind;
  front: string;
  back: string;
  source?: string;
  quote?: string;
  picture?: number;
  confidence?: number;
  due?: number;
};
export type DeckView = { path: string; title: string; course?: string; sources: string[]; cards: Card[] };
export type SessionCard = Card & { deck: string };
export type Rated = { due: number; again: boolean };
export type CardInput = { front: string; back?: string; source?: string | null };

function cardsOf(p: string, d: Deck, states: Record<string, CardState> | undefined): Card[] {
  return deck.cardIds(p, d).map((id, i) => {
    const n = d.notes[i]!;
    const st = states && Object.hasOwn(states, id) ? states[id] : undefined;
    const c: Card = { id, kind: deck.kindOf(n), front: n.front, back: n.back };
    if (n.source !== undefined) c.source = n.source;
    if (n.quote !== undefined) c.quote = n.quote;
    if (n.picture !== undefined) c.picture = n.picture;
    const conf = st ? schedule.lastConfidence(st) : undefined;
    if (conf !== undefined) c.confidence = conf;
    if (st) c.due = st.due;
    return c;
  });
}

export function overview(space: string, now: number): Overview {
  const progress = viewProgress(space);
  const decks: DeckSummary[] = [];
  for (const name of list(space, "deck")) {
    let rel: string;
    let d: Deck;
    try {
      [rel, d] = loadDeck(space, `${DECKS}/${name}`);
    } catch {
      continue;
    }
    const ids = deck.cardIds(rel, d);
    const states = progress.decks[rel];
    const has = (id: string) => states !== undefined && Object.hasOwn(states, id);
    const s: DeckSummary = { path: rel, title: d.title } as DeckSummary;
    if (d.course !== undefined) s.course = d.course;
    s.cards = ids.length;
    s.due = ids.filter((id) => has(id) && states![id]!.due <= now).length;
    s.new = ids.filter((id) => !has(id)).length;
    s.mastery = schedule.mastery(states, ids, now);
    const file = plainFile(space, rel);
    s.updated = file ? modifiedMs(file) : 0;
    decks.push(s);
  }
  const tries = attempts(space);
  const quizzes: QuizSummary[] = [];
  for (const name of list(space, "quiz")) {
    const rel = `${QUIZZES}/${name}`;
    let last: Attempt | undefined;
    for (const a of tries) if (a.quiz === rel && (last === undefined || a.taken >= last.taken)) last = a;
    let title: string;
    let course: string | undefined;
    let questions: number;
    try {
      const [, q] = loadQuiz(space, rel);
      title = q.title;
      course = q.course;
      questions = q.questions.length;
    } catch {
      title = fileTitle(rel);
      questions = 0;
    }
    const s: QuizSummary = { path: rel, title } as QuizSummary;
    if (course !== undefined) s.course = course;
    s.questions = questions;
    if (last) {
      s.lastScore = last.score;
      s.lastTaken = last.taken;
    }
    quizzes.push(s);
  }
  const due = decks.reduce((n, d) => n + d.due, 0);
  const today = schedule.localDay(now, schedule.offsetSecs(now));
  return { decks, quizzes, due, streakDays: schedule.streak(progress.days, today) };
}

export function deckView(space: string, p: string): DeckView {
  const [rel, d] = loadDeck(space, p);
  const progress = viewProgress(space);
  const v: DeckView = { path: rel, title: d.title } as DeckView;
  if (d.course !== undefined) v.course = d.course;
  v.sources = d.sources;
  v.cards = cardsOf(rel, d, progress.decks[rel]);
  return v;
}

const crlf = (s: string) => s.replaceAll("\r\n", "\n");

/**
 * Creates (`p` null or blank) or edits a deck. Editing keeps the file's
 * course, sources and hand-written text; a card keeps its source and passage
 * when its front is unchanged, or when it replaces the card at its position
 * (an edited question); progress follows the card id (the front).
 */
export function deckSave(space: string, p: string | null | undefined, title: string, cards: readonly CardInput[]): string {
  const target = p?.trim() ? p : null;
  const existing = target !== null ? loadDeck(space, target) : null;
  const d: Deck = existing ? structuredClone(existing[1]) : deck.emptyDeck();
  const oldNotes = new Map<string, Note>();
  for (const n of d.notes) oldNotes.set(squeeze(n.front), n);
  const fronts = cards.map((c) => crlf(c.front).trim());
  const newKeys = new Set(fronts.map(squeeze));
  const previous = d.notes;
  d.title = title.trim();
  d.notes = cards.map((c, i) => {
    const front = fronts[i]!;
    let old: Note | undefined = oldNotes.get(squeeze(front));
    if (!old) {
      // Fixed: an edited question keeps where its card came from.
      const at = previous[i];
      if (at && !newKeys.has(squeeze(at.front))) old = at;
    }
    const given = c.source !== undefined && c.source !== null && c.source.trim() !== "" ? c.source : undefined;
    const source = given ?? old?.source;
    const same = source === old?.source;
    const n: Note = { front, back: crlf(c.back ?? "").trim() };
    if (source !== undefined) n.source = source;
    if (same && old?.quote !== undefined) n.quote = old.quote;
    if (same && old?.picture !== undefined) n.picture = old.picture;
    return n;
  });
  deck.validate(d);
  const rel = existing ? existing[0] : freePath(space, "deck", d.title);
  // Checked before writing, so a progress file that can't be read is never left behind a changed deck.
  const progress = loadProgress(space);
  writeFile(space, rel, deck.write(d));
  const ids = new Set(deck.cardIds(rel, d));
  const states = progress.decks[rel];
  if (states) {
    const before = Object.keys(states).length;
    for (const id of Object.keys(states)) if (!ids.has(id)) delete states[id];
    if (Object.keys(states).length !== before) saveProgress(space, progress);
  }
  return rel;
}

/** Writes a new (generated) deck; returns its path. */
export function deckCreate(space: string, d: Deck): string {
  deck.validate(d);
  const rel = freePath(space, "deck", d.title);
  writeFile(space, rel, deck.write(d));
  return rel;
}

export function quizCreate(space: string, q0: Quiz): string {
  const q = structuredClone(q0);
  normalize(q);
  const rel = freePath(space, "quiz", q.title);
  writeFile(space, rel, JSON.stringify(orderQuiz(q), null, 2));
  return rel;
}

/** Saves an attempt as `<quiz>-<taken>.json` (a ` (2)` suffix when that file exists); sets `a.path`. */
export function attemptSave(space: string, a: Attempt): void {
  const stem = takeChars(segment(fileTitle(a.quiz)), 80);
  let rel = `${ATTEMPTS}/${stem}-${a.taken}.json`;
  // Fixed: a second submit in the same millisecond no longer overwrites the first.
  for (let n = 2; fs.existsSync(path.join(space, rel)); n++) rel = `${ATTEMPTS}/${stem}-${a.taken} (${n}).json`;
  a.path = rel;
  checkPath(a.path, "attempt");
  const out: Attempt = { path: a.path, quiz: a.quiz, taken: a.taken, score: a.score, results: a.results };
  writeFile(space, a.path, JSON.stringify(out, null, 2));
}

/**
 * Cards to study: due ones (most overdue first), then new ones in deck order;
 * with chosen decks, then the ones due soonest after that.
 */
export function session(space: string, paths: readonly string[] | null | undefined, limit: number, now: number): SessionCard[] {
  const lim = Math.min(Math.max(Math.trunc(limit), 1), SESSION_MAX);
  const chosen = paths
    ? [...new Set(paths.map((x) => checkPath(x, "deck")))]
    : list(space, "deck").map((n) => `${DECKS}/${n}`);
  const progress = viewProgress(space);
  const due: [number, SessionCard][] = [];
  const fresh: SessionCard[] = [];
  const ahead: [number, SessionCard][] = [];
  for (const p of chosen) {
    let rel: string;
    let d: Deck;
    try {
      [rel, d] = loadDeck(space, p);
    } catch (e) {
      if (paths) throw e;
      continue;
    }
    for (const card of cardsOf(rel, d, progress.decks[rel])) {
      const sc: SessionCard = { ...card, deck: rel };
      if (card.due === undefined) fresh.push(sc);
      else if (card.due <= now) due.push([card.due, sc]);
      else ahead.push([card.due, sc]);
    }
  }
  const byDue = (xs: [number, SessionCard][]) => xs.map((x, i) => [x, i] as const).sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1]).map(([[, c]]) => c);
  const out = [...byDue(due), ...fresh];
  if (paths) out.push(...byDue(ahead));
  return out.slice(0, lim);
}

/** Rates a card 1..5 after seeing its answer. */
export function rate(space: string, deckPath: string, card: string, confidence: number, now: number): Rated {
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) throw "Rate how well you knew it from 1 to 5.";
  const [rel, d] = loadDeck(space, deckPath);
  if (!deck.cardIds(rel, d).includes(card)) throw "That card isn’t in the deck any more; it may have been edited.";
  const exam = schedule.nextExam(loadExams(space), d.course, now, schedule.offsetSecs(now));
  const progress = loadProgress(space);
  const states = (progress.decks[rel] ??= {});
  const [state, again] = schedule.rate(Object.hasOwn(states, card) ? states[card] : undefined, confidence, now, exam);
  states[card] = state;
  const day = schedule.localDay(now, schedule.offsetSecs(now));
  if (!progress.days.includes(day)) progress.days.push(day);
  saveProgress(space, progress);
  return { due: state.due, again };
}

/** Deletes a deck (and its progress) or a quiz (and its attempts). */
export function deleteItem(space: string, p: string): void {
  let rel: string;
  let item: Item;
  try {
    rel = checkPath(p, "deck");
    item = "deck";
  } catch {
    try {
      rel = checkPath(p, "quiz");
      item = "quiz";
    } catch {
      throw "That isn’t a deck or quiz in this space.";
    }
  }
  const file = plainFile(space, rel);
  if (!file) throw "It isn’t in this space any more.";
  const progress = item === "deck" ? loadProgress(space) : null;
  try {
    fs.rmSync(file);
  } catch (e) {
    throw `It couldn’t be deleted: ${errText(e)}`;
  }
  if (progress) {
    if (Object.hasOwn(progress.decks, rel)) {
      delete progress.decks[rel];
      saveProgress(space, progress);
    }
  } else {
    // Fixed: only the attempt files listed in the attempts folder are removed, never a path stored inside one.
    for (const [listed, a] of attemptFiles(space)) {
      if (a.quiz !== rel) continue;
      const f = plainFile(space, listed);
      if (f) fs.rmSync(f, { force: true });
    }
  }
}

/** Fronts of the decks of `course` (or of every deck without one). */
export function existingFronts(space: string, course: string | null | undefined): string[] {
  const out: string[] = [];
  for (const n of list(space, "deck")) {
    let d: Deck;
    try {
      [, d] = loadDeck(space, `${DECKS}/${n}`);
    } catch {
      continue;
    }
    const c = course ?? null;
    const dc = d.course ?? null;
    const match = c !== null && dc !== null ? schedule.sameCourse(c, dc) : c === null && dc === null;
    if (match) out.push(...d.notes.map((x) => x.front));
  }
  return out;
}

// ---- The agent's prompt ------------------------------------------------------------

const PROMPT =
  '# Study\n\nStudy material lives in study/: flashcard decks in study/decks/<Title>.md, quizzes in study/quizzes/<Title>.json, the study plan in study/plan.md and exam dates in study/exams.json ([{"course", "title", "date": "YYYY-MM-DD"}]). A deck is Markdown: front matter between --- lines (title:, optional course: the course folder name, optional sources: a list of files), then the cards, each "Q: <question>" on one line, "A: <answer>" on the next, optionally "From: <file it came from>", with a blank line between cards. Writing {{a term}} in a question makes a fill-in card that hides it. To make flashcards or a quiz for the user, offer it with a phaethon-study block (see "A quiz or flashcards from the chat"). Write a deck file with write_file only when the user asks you to write or edit the cards themselves: one idea per card, from the course\'s own material.';

/** The "# Study" prompt section, for a space that sees courses or has a study folder. */
export function promptSection(space: string, hasCourses: boolean, now: number): string | null {
  if (!hasCourses && !plainDir(space, "study")) return null;
  let s = PROMPT;
  const off = schedule.offsetSecs(now);
  const upcoming: [number, Exam, number][] = [];
  loadExams(space).forEach((e, i) => {
    const t = schedule.examStart(e.date, off);
    if (t !== null && t > now) upcoming.push([t, e, i]);
  });
  upcoming.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
  if (upcoming.length) {
    const items = upcoming.slice(0, 5).map(([, e]) => (e.course !== undefined ? `${e.title} (${e.course}) on ${e.date}` : `${e.title} on ${e.date}`));
    s += `\n\nUpcoming exams: ${items.join("; ")}.`;
  }
  return s;
}
