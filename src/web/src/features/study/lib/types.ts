/**
 * The study commands' wire types: the JSON the core returns and streams, as
 * the Tauri commands had it (research F-ui §1b). `QuizOptions.focus` is part
 * of the contract now (the core always accepted it).
 */

export type DeckSummary = {
  path: string;
  title: string;
  course?: string;
  cards: number;
  /** Cards already studied whose next review is due now. */
  due: number;
  /** Cards never studied. */
  new: number;
  /** 0..1: share of cards last rated 4–5 in the last 30 days. */
  mastery: number;
  updated: number;
};

export type QuizSummary = {
  path: string;
  title: string;
  course?: string;
  /** 0 when the file can't be read. */
  questions: number;
  /** 0..1 */
  lastScore?: number;
  lastTaken?: number;
};

export type StudyOverview = { decks: DeckSummary[]; quizzes: QuizSummary[]; due: number; streakDays: number };

export type Card = {
  id: string;
  kind: "basic" | "cloze";
  front: string;
  back: string;
  source?: string;
  quote?: string;
  picture?: number;
  /** 1..5 */
  confidence?: number;
  due?: number;
};

export type DeckView = { path: string; title: string; course?: string; sources: string[]; cards: Card[] };
export type SessionCard = Card & { deck: string };
export type CardInput = { front: string; back: string; source?: string };

export type QuestionKind = "choice" | "multi" | "truefalse" | "short" | "cloze";

export type Evidence = {
  /** "courses/<folder>/<path>" or "from you" */
  source: string;
  quote: string;
  /** "§5.3", "#3", "p. 4" */
  at?: string;
  picture?: number;
};

export type Question = {
  id: string;
  kind: QuestionKind;
  prompt: string;
  choices?: string[];
  answer: string | string[];
  accept?: string[];
  explanation: string;
  source?: string;
  topic?: string;
  citations?: Evidence[];
};

export type MaterialAlert = { kind: "cantSee" | "unknown" | "notShown"; text: string };
export type Sight = { sees: "yes" | "no" | "unknown"; model: string; shown: boolean };
export type MaterialView = {
  lines: string[];
  pages: number;
  sight: Sight;
  alert?: MaterialAlert;
  exams: { title: string; pages: number; alert?: MaterialAlert }[];
};

export type Grounding = {
  exam?: string;
  scope?: string;
  fromUser: boolean;
  evidence: Evidence[];
  asked: number;
  kept: number;
  dropped: { text: string; why: string }[];
  coverage: { topic: string; sections?: string; count: number; why?: string }[];
  notes?: string[];
};

export type Quiz = { title: string; course?: string; sources: string[]; created: number; questions: Question[]; grounding?: Grounding };

/** What a question's answer may be on the wire (the core also accepts a bool for true/false). */
export type GivenAnswer = string | string[] | boolean;

export type QuestionResult = {
  id: string;
  correct: boolean;
  /** 0..1 */
  partial?: number;
  given: GivenAnswer;
  expected: GivenAnswer;
  feedback: string;
  /** The core couldn't grade it (no model): left out of the score. */
  ungraded?: boolean;
};

export type Attempt = { path: string; quiz: string; taken: number; score: number; results: QuestionResult[] };

export type StudyStep = "mapping" | "reading" | "making" | "checking" | "saving" | "grading" | "reviewing";
export type UnknownScope = { course: string; courseName: string; exam: string };

export type StudyEvent =
  | { type: "progress"; step: StudyStep; done: number; total: number; kept?: number; dropped?: number }
  | {
      type: "done";
      path?: string;
      cards?: number;
      questions?: number;
      grounding?: Grounding;
      attempt?: Attempt;
      summary?: string;
      deckPath?: string;
    }
  | { type: "error"; message: string }
  | { type: "cancelled" }
  | ({ type: "needsScope" } & UnknownScope);

export type Confidence = 1 | 2 | 3 | 4 | 5;

export type DeckOptions = { count: number; focus?: string; title?: string; fromAttempt?: string; exam?: string };
export type QuizOptions = {
  count: number;
  kinds: QuestionKind[];
  difficulty: "easier" | "exam" | "harder";
  title?: string;
  focus?: string;
  exam?: string;
};

export type CourseSource = { name: string; folder: string; syllabus: boolean; assignments: boolean; files: boolean; readings: boolean };

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

export type ScopeTopic = {
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

export type ScopeMap = {
  course: string;
  name: string;
  built: number;
  topics: ScopeTopic[];
  notation: { symbol: string; meaning: string; evidence: Evidence[] }[];
  exams: ExamScope[];
  dropped: number;
};

export type ScopeView = {
  /** "courses/<folder>" */
  course: string;
  name: string;
  state: "none" | "fresh" | "stale";
  map?: ScopeMap;
  stated: { exam: string; text: string; at: number }[];
  material?: MaterialView;
};

export type CitationCheck = {
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
