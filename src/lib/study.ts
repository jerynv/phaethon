import { Channel, invoke } from "@tauri-apps/api/core";

import type { StudyPlan } from "./study-chat";

/**
 * Study: flashcard decks, quizzes and making both from course material.
 * Mirrors the `study_*` commands in src-tauri/src/study/commands.rs. Decks and
 * quizzes are named by their path in the space ("study/decks/Sets.md",
 * "study/quizzes/Test 1.json"); the core checks every path.
 */

export type DeckSummary = {
  path: string;
  title: string;
  /** The course folder name, e.g. "CSCI-C 241 Fall 2026 (All Sections)". */
  course?: string;
  cards: number;
  /** Cards due now. */
  due: number;
  /** Cards never studied. */
  new: number;
  /** 0..1: share of cards last rated 4 or 5 in the last 30 days. */
  mastery: number;
  /** File last changed, ms since the epoch. */
  updated: number;
};

export type QuizSummary = {
  path: string;
  title: string;
  course?: string;
  /** 0 when the quiz file can't be read (shown so it can be deleted). */
  questions: number;
  /** 0..1 */
  lastScore?: number;
  lastTaken?: number;
};

export type StudyOverview = { decks: DeckSummary[]; quizzes: QuizSummary[]; due: number; streakDays: number };

/**
 * A card. For `cloze`, `front` keeps its `{{...}}` blanks (one card hides every
 * blank at once; render them with `clozeParts`) and `back` is an optional extra note.
 */
export type Card = {
  id: string;
  kind: "basic" | "cloze";
  front: string;
  back: string;
  /** The file it came from, relative to the space. */
  source?: string;
  /** The passage in that file it was made from, word for word (checked when it was made). */
  quote?: string;
  /** The page whose picture the passage was read from (handwriting, a scan): checked only roughly. */
  picture?: number;
  /** The last rating, 1..5. */
  confidence?: number;
  /** When it's due next, ms. */
  due?: number;
};

export type DeckView = { path: string; title: string; course?: string; sources: string[]; cards: Card[] };
export type SessionCard = Card & { deck: string };
export type CardInput = { front: string; back: string; source?: string };

export type QuestionKind = "choice" | "multi" | "truefalse" | "short" | "cloze";

export type Question = {
  id: string;
  kind: QuestionKind;
  prompt: string;
  /** choice / multi; truefalse has ["true", "false"]. */
  choices?: string[];
  /** multi: every right choice; truefalse: "true" | "false"; cloze: also see `accept`. */
  answer: string | string[];
  /** cloze only: other answers that count. */
  accept?: string[];
  explanation: string;
  source?: string;
  /** The course topic it tests, as the course names it ("Injective functions (5.3)"). */
  topic?: string;
  /** The passages it is built on, each found word for word in its file when it was made. */
  citations?: Evidence[];
};

/** Mirrors `Evidence` in src-tauri/src/study/scope.rs: a passage, checked to be in its file. */
export type Evidence = {
  /** `courses/<folder>/<path>` (the PDF's own name for its text copy), or "from you". */
  source: string;
  quote: string;
  /** Where in the file: "§5.3", "#3", "p. 4". */
  at?: string;
  /** Read by the model from the picture of this page (handwriting, a scan): checked only roughly. */
  picture?: number;
};

/** Mirrors `Sight` in src-tauri/src/vision.rs: whether the space's model can look at pictures. */
export type Sight = { sees: "yes" | "no" | "unknown"; model: string; shown: boolean };
/** Mirrors `Alert` in vision.rs. */
export type MaterialAlert = { kind: "cantSee" | "unknown" | "notShown"; text: string };
/** Mirrors `MaterialView` in study/material.rs. */
export type MaterialView = {
  lines: string[];
  pages: number;
  sight: Sight;
  alert?: MaterialAlert;
  exams: { title: string; pages: number; alert?: MaterialAlert }[];
};

/** Mirrors `Grounding` in src-tauri/src/study/grounded.rs: what a quiz or deck was made against, and how the check went. */
export type Grounding = {
  /** The exam it is for ("Test 1"). */
  exam?: string;
  /** That exam's scope in words ("through HW 6; not graphs or combinatorics"). */
  scope?: string;
  /** The scope is the person's word, not found in the materials. */
  fromUser: boolean;
  evidence: Evidence[];
  asked: number;
  kept: number;
  dropped: { text: string; why: string }[];
  /** Each topic in scope, how many it got, and why none when none. */
  coverage: { topic: string; sections?: string; count: number; why?: string }[];
  /** Said when fewer were kept than asked for, or a focus didn't match. */
  notes?: string[];
};

export type Quiz = { title: string; course?: string; sources: string[]; created: number; questions: Question[]; grounding?: Grounding };

export type QuestionResult = {
  id: string;
  correct: boolean;
  /** Partial credit 0..1 when neither right nor wrong. */
  partial?: number;
  given: string | string[];
  expected: string | string[];
  /** Plain words: right or not, why, and the file it's from. */
  feedback: string;
  /** A short answer that couldn't be graded (no model); left out of the score. */
  ungraded?: boolean;
};

/** `path` is the attempt's own (".phaethon/study/attempts/…"), `quiz` the quiz's. */
export type Attempt = { path: string; quiz: string; taken: number; score: number; results: QuestionResult[] };

/**
 * What a step is doing: "mapping" (what the course teaches and each exam
 * covers), "reading", "making" (`done` is the writing round), "checking"
 * (each one against the notes, with `kept` and `dropped` so far), "saving",
 * "grading", "reviewing".
 */
export type StudyStep = "mapping" | "reading" | "making" | "checking" | "saving" | "grading" | "reviewing";

/** An exam whose scope couldn't be found: the person can say what it covers (`studyScopeState`). */
export type UnknownScope = { course: string; courseName: string; exam: string };

/** Streamed by the make, submit and review calls; ends with exactly one `done` or `error`. */
export type StudyEvent =
  | { type: "progress"; step: StudyStep; done: number; total: number; kept?: number; dropped?: number }
  | {
      type: "done";
      /** make: the new deck's or quiz's path. */
      path?: string;
      cards?: number;
      questions?: number;
      /** make: what it was made against and how the check went. */
      grounding?: Grounding;
      /** submit */
      attempt?: Attempt;
      /** review: markdown, what to study next by topic. */
      summary?: string;
      deckPath?: string;
    }
  | { type: "error"; message: string }
  /** study_chat_make only: stopped with studyChatCancel; nothing was saved. */
  | { type: "cancelled" }
  /** make: the exam's scope wasn't found, so nothing was made; comes just before the `error`. */
  | ({ type: "needsScope" } & UnknownScope);

/** Confidence after seeing the answer: 1 "Not at all" … 5 "Perfectly". */
export type Confidence = 1 | 2 | 3 | 4 | 5;

/** Where a card rated `again` comes back in the session: this many cards later (or at the end). */
export const AGAIN_AFTER: Record<1 | 2, number> = { 1: 3, 2: 8 };

/** Put `card` back into `queue` (the cards still to show) after a rating that says `again`. */
export function requeue<T>(queue: T[], card: T, confidence: Confidence): T[] {
  const after = confidence === 1 ? AGAIN_AFTER[1] : AGAIN_AFTER[2];
  const at = Math.min(after, queue.length);
  return [...queue.slice(0, at), card, ...queue.slice(at)];
}

/** A cloze front split into text and blanks ("{{c1::text::hint}}" reads as "text"). */
/** Where a card comes from, as a question's citations say it: its passage, and the page whose picture it was read from. */
export function cardCites(c: Card): Evidence[] {
  if (!c.source || !c.quote) return [];
  return [{ source: c.source, quote: c.quote, ...(c.picture ? { at: `p. ${c.picture}`, picture: c.picture } : {}) }];
}

export function clozeParts(front: string): Array<{ text: string; blank: boolean }> {
  const out: Array<{ text: string; blank: boolean }> = [];
  const re = /\{\{(.*?)\}\}/gs;
  let last = 0;
  for (let m = re.exec(front); m; m = re.exec(front)) {
    if (m.index > last) out.push({ text: front.slice(last, m.index), blank: false });
    let inner = m[1];
    const tag = /^[cC]\d+::/.exec(inner);
    if (tag) inner = inner.slice(tag[0].length);
    out.push({ text: inner.split("::")[0].trim(), blank: true });
    last = m.index + m[0].length;
  }
  if (last < front.length) out.push({ text: front.slice(last), blank: false });
  return out;
}

function stream(cmd: string, args: Record<string, unknown>, onEvent: (e: StudyEvent) => void): Promise<void> {
  const channel = new Channel<StudyEvent>();
  channel.onmessage = onEvent;
  return invoke<void>(cmd, { ...args, onEvent: channel });
}


/** Mirrors `CourseSource` in src-tauri/src/study/sources.rs: an imported course and the parts its folder has. */
export type CourseSource = { name: string; folder: string; syllabus: boolean; assignments: boolean; files: boolean; readings: boolean };
/** The space's imported courses, for choosing what to make cards or a quiz from. */
export const studySources = (space: string) => invoke<CourseSource[]>("study_sources", { space });
export const studyOverview = (space: string) => invoke<StudyOverview>("study_overview", { space });

export const studyDeck = (space: string, path: string) => invoke<DeckView>("study_deck", { space, path });

/** Create (`path` null) or edit a deck; resolves with its path. Rejects with the problem in plain words. */
export const studyDeckSave = (space: string, path: string | null, title: string, cards: CardInput[]) =>
  invoke<string>("study_deck_save", { space, path, title, cards });

/** Cards in the order to show: due first, then new. `paths` null = every deck; chosen decks also offer cards due later. */
export const studySession = (space: string, paths: string[] | null, limit = 20) =>
  invoke<SessionCard[]>("study_session", { space, paths, limit });

/** `again`: show it again this session (see `requeue`). */
export const studyRate = (space: string, deck: string, card: string, confidence: Confidence) =>
  invoke<{ due: number; again: boolean }>("study_rate", { space, deck, card, confidence });

/** `exam` ("Test 1"): only that exam's scope is used; unknown scope ends in `needsScope` then `error`. */
export type DeckOptions = { count: number; focus?: string; title?: string; fromAttempt?: string; exam?: string };
export type QuizOptions = { count: number; kinds: QuestionKind[]; difficulty: "easier" | "exam" | "harder"; title?: string; exam?: string };

/** `sources`: course folders or files in the space (may be empty with `fromAttempt`). */
export const studyMakeDeck = (space: string, sources: string[], options: DeckOptions, onEvent: (e: StudyEvent) => void) =>
  stream("study_make_deck", { space, sources, options }, onEvent);

export const studyMakeQuiz = (space: string, sources: string[], options: QuizOptions, onEvent: (e: StudyEvent) => void) =>
  stream("study_make_quiz", { space, sources, options }, onEvent);

export const studyQuiz = (space: string, path: string) => invoke<Quiz>("study_quiz", { space, path });

/** `answers` by question id: a string, or the chosen choices for multi. */
export const studyQuizSubmit = (
  space: string,
  path: string,
  answers: Record<string, string | string[]>,
  onEvent: (e: StudyEvent) => void,
) => stream("study_quiz_submit", { space, path, answers }, onEvent);

/** `done.summary`; offer a deck from the mistakes with `studyMakeDeck(space, [], { count, fromAttempt })`. */
export const studyReviewMistakes = (space: string, attemptPath: string, onEvent: (e: StudyEvent) => void) =>
  stream("study_review_mistakes", { space, attemptPath }, onEvent);

/** Delete a deck (and its progress) or a quiz (and its attempts). */
export const studyDelete = (space: string, path: string) => invoke<void>("study_delete", { space, path });

// ---- A quiz or deck offered in a chat reply (src-tauri/src/study/chat.rs) ----

/** What a reply's phaethon-study block will make, checked by the core. Rejects with why it can't be used. */
export const studyChatPlan = (space: string, block: string, question: string) =>
  invoke<StudyPlan>("study_chat_plan", { space, block, question });

/**
 * Make it, with the conversation (`question`, `reply`) as context. Ends with
 * `done` (its path; also when it was made before), `error` or `cancelled`.
 */
export const studyChatMake = (space: string, block: string, question: string, reply: string, onEvent: (e: StudyEvent) => void) =>
  stream("study_chat_make", { space, block, question, reply }, onEvent);

/** Stop making a plan, by its origin. */
export const studyChatCancel = (space: string, origin: string) => invoke<boolean>("study_chat_cancel", { space, origin });

// ---- What a course teaches and its exams cover (src-tauri/src/study/scope.rs) ----

/** Mirrors `ExamScope` in scope.rs. */
export type ExamScope = {
  title: string;
  date?: string;
  /** Whether what it covers was found (or said by the person). */
  known: boolean;
  summary: string;
  includes: string[];
  excludes: string[];
  excludedWords: string[];
  homework: string[];
  evidence: Evidence[];
  fromUser: boolean;
};

/** Mirrors `ScopeMap` in scope.rs. */
export type ScopeMap = {
  course: string;
  name: string;
  built: number;
  topics: { id: string; title: string; sections?: string; terms: string[]; weight: number; homework: string[]; evidence: Evidence[]; reference?: boolean; assignedBy?: Evidence[] }[];
  notation: { symbol: string; meaning: string; evidence: Evidence[] }[];
  exams: ExamScope[];
  /** Quotes the model gave that weren't in the files, so were dropped. */
  dropped: number;
};

/** Mirrors `ScopeView` in study/commands.rs. */
export type ScopeView = {
  /** "courses/<folder>" */
  course: string;
  name: string;
  state: "none" | "fresh" | "stale";
  map?: ScopeMap;
  stated: { exam: string; text: string; at: number }[];
  /** What the course's documents are made of, and whether the space's model can look at the pictures. */
  material?: MaterialView;
};

/** A course's scope map as this space sees it (only what is kept; nothing is built here). */
export const studyScope = (space: string, course: string) => invoke<ScopeView>("study_scope", { space, course });

/** Map the course again: `mapping` progress, then `done` or `error`. */
export const studyScopeBuild = (space: string, course: string, onEvent: (e: StudyEvent) => void) => stream("study_scope_build", { space, course }, onEvent);

/** Say what an exam covers (shown as "from you"); an empty `text` forgets it. */
export const studyScopeState = (space: string, course: string, exam: string, text: string) =>
  invoke<void>("study_scope_state", { space, course, exam, text });

/** Mirrors `Checked` in src-tauri/src/study/citations.rs. */
export type CitationCheck = {
  found: boolean;
  /** The file as the space names it, or the path as written. */
  path: string;
  name: string;
  at?: string;
  before?: string;
  passage?: string;
  after?: string;
  /** Why it wasn't found, in plain words. */
  why?: string;
};

/** Whether each `[source: … "…"]` in a reply is really in that file, as this space may read it. */
export const studyCitationsCheck = (space: string, citations: { path: string; quote: string }[]) =>
  invoke<CitationCheck[]>("study_citations_check", { space, citations });
