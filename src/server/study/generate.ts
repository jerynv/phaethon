import { TITLE_MAX } from "./deck.ts";
import { make, type Ask } from "./grounded.ts";
import { mistakes, mistakesBlock, strOf } from "./items.ts";
import { askJson, type Model } from "./model.ts";
import { GRADE_SYSTEM, REVIEW_SYSTEM } from "./prompts.ts";
import { KINDS, answerText, grade, score } from "./quiz.ts";
import { courseOf } from "./sources.ts";
import { attemptSave, courseOnly, deckCreate, existingFronts, loadAttempt, loadQuiz, quizCreate } from "./store.ts";
import { baseName, takeChars } from "./text.ts";
import { progress, type Answer, type Attempt, type Deck, type Emit, type Grounding, type Note, type Question, type QuestionResult, type Quiz } from "./types.ts";
import type { Visible } from "./visible.ts";

/**
 * Making decks and quizzes from course material through the grounded
 * pipeline, grading a submitted quiz, and reviewing its mistakes (Rust
 * `study::generate`).
 */

export const GENERATE_MAX_CARDS = 100;
export const GENERATE_MAX_QUESTIONS = 50;
const EXISTING_MAX = 150;

export type DeckOptions = { count?: number; focus?: string | null; title?: string | null; fromAttempt?: string | null; context?: string | null; exam?: string | null };
export type QuizOptions = { count?: number; kinds?: string[]; difficulty?: string | null; focus?: string | null; title?: string | null; context?: string | null; exam?: string | null };

const nonBlank = (s: string | null | undefined): string | null => (s && s.trim() !== "" ? s : null);

/** Makes a deck; returns its path, how many cards it has, and how they were grounded. */
export async function makeDeck(space: string, visible: Visible, inputs0: readonly string[], opts: DeckOptions, model: Model, emit: Emit, now: number): Promise<[string, number, Grounding]> {
  const count = !opts.count ? 20 : Math.min(opts.count, GENERATE_MAX_CARDS);
  let inputs = [...inputs0];
  let focus = nonBlank(opts.focus);
  let extra = "";
  let defaultTitle: string | null = null;
  if (opts.fromAttempt) {
    const attempt = loadAttempt(space, opts.fromAttempt);
    const [, quiz] = loadQuiz(space, attempt.quiz);
    const missed = mistakes(quiz, attempt);
    if (!missed.length) throw "You got everything right in that quiz, so there are no mistakes to make cards from.";
    const cited = missed.map(([q]) => q.source).filter((s): s is string => s !== undefined);
    inputs.push(...(cited.length ? cited : quiz.sources));
    inputs = [...new Set(inputs)];
    const topics = [...new Set(missed.map(([q]) => q.topic).filter((t): t is string => t !== undefined).map((t) => t.split(" (")[0]!))];
    if (!focus && topics.length) focus = topics.join(", ");
    extra = `\n\nThe student got these quiz questions wrong. Make the cards about the ideas behind them (what they misunderstood), not copies of the questions.\n${mistakesBlock(missed)}`;
    defaultTitle = `Mistakes from ${quiz.title}`;
  }
  if (!inputs.length) throw "Choose a course or some files to make cards from.";
  const course = courseOf(space, visible, inputs)?.state.folder ?? null;
  const shown = existingFronts(space, course).reverse().slice(0, EXISTING_MAX);
  // The focus line names what the student asked for, or what they got wrong.
  const focusLine = focus ? `\n\nFocus on: ${focus}.` : "";
  const ask: Ask = { count, exam: nonBlank(opts.exam), focus, context: nonBlank(opts.context), extra: focusLine + extra };
  const made = await make(space, visible, inputs, { kind: "deck", existing: shown }, ask, model, emit, now);
  emit(progress("saving", 0, 1));
  const notes: Note[] = made.items.flatMap((i) => (i.kind === "n" ? [i.n] : []));
  const title = nonBlank(opts.title) ?? defaultTitle ?? made.title ?? "New deck";
  const used: string[] = [];
  for (const n of notes) if (n.source !== undefined && !used.includes(n.source)) used.push(n.source);
  const d: Deck = { title: takeChars(title.trim(), TITLE_MAX), sources: used, extra: [], preamble: "", notes };
  const c = made.material.course ?? course;
  if (c) d.course = c;
  const path = deckCreate(space, d);
  emit(progress("saving", 1, 1));
  return [path, notes.length, made.grounding];
}

/** Makes a quiz; returns its path, how many questions, and how they were grounded. */
export async function makeQuiz(space: string, visible: Visible, inputs: readonly string[], opts: QuizOptions, model: Model, emit: Emit, now: number): Promise<[string, number, Grounding]> {
  const count = !opts.count ? 10 : Math.min(opts.count, GENERATE_MAX_QUESTIONS);
  let kinds = [...new Set((opts.kinds ?? []).filter((k) => (KINDS as readonly string[]).includes(k)))];
  if (!kinds.length) {
    if ((opts.kinds ?? []).length) throw "Choose kinds of question from: choice, multi, truefalse, short, cloze.";
    kinds = ["choice", "truefalse", "short"];
  }
  const difficulty = opts.difficulty ?? "exam";
  if (!["easier", "exam", "harder"].includes(difficulty)) throw "Difficulty is easier, exam or harder.";
  if (!inputs.length) throw "Choose a course or some files to make the quiz from.";
  const focus = nonBlank(opts.focus);
  const focusLine = focus ? `\n\nFocus on: ${focus}.` : "";
  const ask: Ask = { count, exam: nonBlank(opts.exam), focus, context: nonBlank(opts.context), extra: focusLine };
  const made = await make(space, visible, inputs, { kind: "quiz", kinds, difficulty }, ask, model, emit, now);
  emit(progress("saving", 0, 1));
  const questions: Question[] = made.items.flatMap((i) => (i.kind === "q" ? [i.q] : []));
  const title = takeChars((nonBlank(opts.title) ?? made.title ?? "New quiz").trim(), TITLE_MAX);
  const sources: string[] = [];
  for (const q of questions) for (const c of q.citations ?? []) if (!sources.includes(c.source)) sources.push(c.source);
  // The material's course wins, as for decks (the Rust code had the two in opposite orders).
  const course = made.material.course ?? courseOf(space, visible, [...inputs])?.state.folder ?? null;
  const quiz: Quiz = { title, sources, created: now, questions, grounding: made.grounding };
  if (course) quiz.course = course;
  const path = quizCreate(space, quiz);
  emit(progress("saving", 1, 1));
  return [path, questions.length, made.grounding];
}

function checkGrades(queued: readonly string[]): (v: unknown) => Map<string, [number, string]> {
  return (v) => {
    const g = (v as Record<string, unknown> | null)?.grades;
    const list = Array.isArray(g) ? g : Array.isArray(v) ? v : null;
    if (!list) throw 'expected an object with a "grades" array';
    const got = new Map<string, [number, string]>();
    for (const x of list) {
      const id = strOf(x, "id");
      const s = (x as Record<string, unknown> | null)?.score;
      if (typeof s !== "number") throw `the grade for ${id} has no numeric score`;
      if (s < 0 || s > 1) throw `the score for ${id} must be between 0 and 1`;
      const feedback = strOf(x, "feedback");
      if (feedback === "") throw `the grade for ${id} has no feedback`;
      if (!got.has(id)) got.set(id, [s, feedback]);
    }
    for (const id of queued) if (!got.has(id)) throw `there is no grade for question ${id}`;
    return got;
  };
}

const fromNote = (q: Question) => (q.source !== undefined ? ` (From ${baseName(q.source)}.)` : "");

/** Grades a submitted quiz and saves the attempt. `modelFactory` is called only if a short answer needs a model. */
export async function submit(space: string, path: string, answers: Record<string, Answer>, modelFactory: () => Model, emit: Emit, now: number): Promise<Attempt> {
  const [rel, quiz] = loadQuiz(space, path);
  const results: (QuestionResult | null)[] = [];
  const queued: { q: Question; given: Answer; at: number }[] = [];
  for (const q of quiz.questions) {
    const given = answers[q.id] ?? "";
    const r = grade(q, given);
    if (r === null) queued.push({ q, given, at: results.length });
    results.push(r);
  }
  if (queued.length) {
    emit(progress("grading", 0, queued.length));
    let user = "Grade these answers.\n\n";
    for (const { q, given } of queued) {
      user += `<question id="${q.id}">\nQuestion: ${q.prompt}\nModel answer: ${answerText(q.answer)}\nExplanation: ${q.explanation}\nStudent's answer: ${answerText(given)}\n</question>\n\n`;
    }
    let grades: Map<string, [number, string]> | null = null;
    let failure = "";
    try {
      grades = await askJson(modelFactory(), courseOnly(GRADE_SYSTEM), user, checkGrades(queued.map((x) => x.q.id)));
    } catch (e) {
      failure = typeof e === "string" ? e : (e as Error).message;
    }
    for (const { q, given, at } of queued) {
      const g = grades?.get(q.id);
      const r: QuestionResult = { id: q.id, correct: false, given, expected: q.answer, feedback: "" };
      if (g) {
        r.correct = g[0] >= 0.95;
        if (!r.correct && g[0] > 0) r.partial = g[0];
        r.feedback = g[1] + fromNote(q);
      } else {
        r.feedback = `This one couldn’t be graded: ${failure} Compare yours with a good answer: ${answerText(q.answer)}${fromNote(q)}`;
        r.ungraded = true;
      }
      results[at] = orderResult(r);
    }
    emit(progress("grading", queued.length, queued.length));
  }
  const done = results as QuestionResult[];
  const attempt: Attempt = { path: "", quiz: rel, taken: now, score: score(done), results: done };
  attemptSave(space, attempt);
  return attempt;
}

function orderResult(r: QuestionResult): QuestionResult {
  const o = { id: r.id, correct: r.correct } as QuestionResult;
  if (r.partial !== undefined) o.partial = r.partial;
  Object.assign(o, { given: r.given, expected: r.expected, feedback: r.feedback });
  if (r.ungraded) o.ungraded = true;
  return o;
}

function plainReview(list: readonly [Question, QuestionResult][]): string {
  const groups: [string, Question[]][] = [];
  for (const [q] of list) {
    const key = q.source !== undefined ? baseName(q.source) : "Other";
    const g = groups.find(([k]) => k === key);
    if (g) g[1].push(q);
    else groups.push([key, [q]]);
  }
  let s = "";
  for (const [k, qs] of groups) {
    s += `## ${k}\n\n`;
    for (const q of qs) s += `- ${q.prompt} The answer is ${answerText(q.answer)}.\n`;
    s += "\n";
  }
  return s.trimEnd();
}

function stripFence(t0: string): string {
  const t = t0.trim();
  for (const open of ["```markdown", "```md", "```"]) {
    if (t.startsWith(open) && t.endsWith("```") && t.length >= open.length + 3) return t.slice(open.length, t.length - 3).trim();
  }
  return t;
}

/** A review of an attempt's mistakes, in Markdown. Model failures fall back to a plain list. */
export async function review(space: string, attemptPath: string, modelFactory: () => Model, emit: Emit): Promise<string> {
  const attempt = loadAttempt(space, attemptPath);
  const [, quiz] = loadQuiz(space, attempt.quiz);
  const missed = mistakes(quiz, attempt);
  if (!missed.length) return "You got everything right on this quiz. Nothing to review: try a harder quiz, or keep up your flashcards.";
  emit(progress("reviewing", 0, 1));
  const user = `Quiz: ${quiz.title}\n\n${mistakesBlock(missed)}`;
  let out: string;
  try {
    const reply = await modelFactory().complete(courseOnly(REVIEW_SYSTEM), user);
    out = reply.trim() === "" ? plainReview(missed) : stripFence(reply);
  } catch (e) {
    out = `${plainReview(missed)}\n\n_A fuller review needs a model: ${typeof e === "string" ? e : (e as Error).message}_`;
  }
  emit(progress("reviewing", 1, 1));
  return out;
}
