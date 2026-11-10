/**
 * Shapes shared across Study: the JSON written to disk and sent to the
 * renderer. Field names and optionality match the Rust serde shapes exactly
 * (omitted = `?`).
 */

/** A quiz answer: untagged string | string[] | bool. */
export type Answer = string | string[] | boolean;

/** A passage something is built on. `source` = `courses/<folder>/<path>` or `"from you"`. */
export type Evidence = { source: string; quote: string; at?: string; picture?: number };

export type Topic = {
  id: string;
  title: string;
  sections?: string;
  terms: string[];
  weight: number;
  homework: string[];
  evidence: Evidence[];
  reference?: boolean;
  assignedBy?: Evidence[];
};

export type Notation = { symbol: string; meaning: string; evidence: Evidence[] };

export type ExamScope = {
  title: string;
  date?: string;
  known: boolean;
  summary: string;
  includes: string[];
  excludes: string[];
  excludedWords: string[];
  homework: string[];
  evidence: Evidence[];
  fromUser: boolean;
};

export type ScopeMap = {
  version: number;
  course: string;
  name: string;
  parts: string[];
  fingerprint: string;
  built: number;
  topics: Topic[];
  notation: Notation[];
  exams: ExamScope[];
  dropped: number;
};

export type Stated = {
  exam: string;
  text: string;
  at: number;
  includes: string[];
  excludes: string[];
  resolvedFor?: string;
};

export type Dropped = { text: string; why: string };
export type Coverage = { topic: string; sections?: string; count: number; why?: string };
export type Grounding = {
  exam?: string;
  scope?: string;
  fromUser: boolean;
  evidence: Evidence[];
  asked: number;
  kept: number;
  dropped: Dropped[];
  coverage: Coverage[];
  notes?: string[];
};

export type QuestionKind = "choice" | "multi" | "truefalse" | "short" | "cloze";

export type Question = {
  id: string;
  kind: string;
  prompt: string;
  choices?: string[];
  answer: Answer;
  accept?: string[];
  explanation: string;
  source?: string;
  topic?: string;
  citations?: Evidence[];
  /**
   * For choice and multi questions: each wrong choice and the specific
   * mistake that leads to it, shown when a student picks it. New in the
   * TypeScript core; old files without it read the same.
   */
  misconceptions?: Record<string, string>;
};

export type Quiz = {
  title: string;
  course?: string;
  sources: string[];
  created: number;
  questions: Question[];
  grounding?: Grounding;
};

export type QuestionResult = {
  id: string;
  correct: boolean;
  partial?: number;
  given: Answer;
  expected: Answer;
  feedback: string;
  ungraded?: boolean;
};

export type Attempt = { path: string; quiz: string; taken: number; score: number; results: QuestionResult[] };

export type Note = { front: string; back: string; source?: string; quote?: string; picture?: number };

export type Deck = {
  title: string;
  course?: string;
  sources: string[];
  /** Front-matter lines Phaethon doesn't know, kept verbatim. */
  extra: string[];
  /** Text before the first card. */
  preamble: string;
  notes: Note[];
};

export type Picture = { label: string; mime: string; data: string };

export type Sees = "yes" | "no" | "unknown";
export type Sight = { sees: Sees; model: string; shown: boolean };
export type Alert = { kind: "cantSee" | "unknown" | "notShown"; text: string };

/** What `done` carries (each field omitted when unset). */
export type Finished = {
  path?: string;
  cards?: number;
  questions?: number;
  attempt?: Attempt;
  summary?: string;
  deckPath?: string;
  grounding?: Grounding;
};

export type UnknownScope = { course: string; courseName: string; exam: string };

export type ProgressStep = "mapping" | "reading" | "making" | "checking" | "saving" | "grading" | "reviewing";

/** The `onEvent` channel payload of the streaming study commands. */
export type StudyEvent =
  | { type: "progress"; step: ProgressStep; done: number; total: number; kept?: number; dropped?: number }
  | ({ type: "done" } & Finished)
  | { type: "error"; message: string }
  | { type: "cancelled" }
  | ({ type: "needsScope" } & UnknownScope);

export type Emit = (e: StudyEvent) => void;

export const progress = (step: ProgressStep, done: number, total: number): StudyEvent => ({ type: "progress", step, done, total });
