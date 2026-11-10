import type { Answer, Attempt, Evidence, Grounding, Question, QuestionResult, Quiz } from "./types.ts";
import { asciiLower, charLen, isAlnum, levenshtein, parseRustF64, trimChars } from "./text.ts";

/**
 * Quizzes (`study/quizzes/<Title>.json`) and grading every kind but short
 * answers, which the model grades (port of `study/quiz.rs`).
 */

export const KINDS = ["choice", "multi", "truefalse", "short", "cloze"] as const;
/** Questions one quiz file may hold (generation caps lower). */
export const QUIZ_FILE_MAX_QUESTIONS = 100;
const PROMPT_MAX = 2_000;
const CHOICE_MAX = 500;

export function answerOne(a: Answer): string | null {
  if (typeof a === "string") return a;
  if (typeof a === "boolean") return String(a);
  return a.length === 1 ? a[0]! : null;
}
export function answerMany(a: Answer): string[] {
  if (Array.isArray(a)) return [...a];
  return [typeof a === "boolean" ? String(a) : a];
}
export function answerText(a: Answer): string {
  return Array.isArray(a) ? a.join(", ") : (answerOne(a) ?? "");
}

export function score(results: readonly QuestionResult[]): number {
  const graded = results.filter((r) => !r.ungraded);
  if (!graded.length) return 0;
  return graded.reduce((n, r) => n + (r.correct ? 1 : (r.partial ?? 0)), 0) / graded.length;
}

/** Normalises a quiz as read and checks it; throws in plain words. */
export function normalize(quiz: Quiz): void {
  if (quiz.title.trim() === "") throw "The quiz needs a title.";
  if (!quiz.questions.length) throw "The quiz has no questions.";
  if (quiz.questions.length > QUIZ_FILE_MAX_QUESTIONS) throw `A quiz can hold up to ${QUIZ_FILE_MAX_QUESTIONS} questions.`;
  const ids = new Set<string>();
  quiz.questions.forEach((q, i) => {
    const n = i + 1;
    if (q.id.trim() === "") q.id = `q${n}`;
    if (ids.has(q.id)) throw `Two questions share the id "${q.id}".`;
    ids.add(q.id);
    try {
      checkQuestion(q);
    } catch (e) {
      throw `Question ${n}: ${String(e)}`;
    }
  });
}

/** One question's shape, fixing what can be fixed (`true` → "true"). */
export function checkQuestion(q: Question): void {
  if (!(KINDS as readonly string[]).includes(q.kind)) throw `"${q.kind}" isn't a kind of question (use one of ${KINDS.join(", ")}).`;
  if (typeof q.answer === "boolean") q.answer = String(q.answer);
  const prompt = q.prompt.trim();
  if (prompt === "") throw "it has no question.";
  if (charLen(prompt) > PROMPT_MAX) throw "the question is too long.";
  const choices = q.choices ? [...q.choices] : [];
  const inChoices = (a: string) => choices.some((c) => c.trim() === a.trim());
  if (q.kind === "choice" || q.kind === "multi") {
    if (choices.length < 2 || choices.length > 8) throw "it needs between 2 and 8 choices.";
    if (choices.some((c) => c.trim() === "" || charLen(c) > CHOICE_MAX)) throw "a choice is empty or too long.";
    if (new Set(choices.map((c) => c.trim().toLowerCase())).size !== choices.length) throw "two choices are the same.";
    if (q.kind === "choice") {
      const a = answerOne(q.answer);
      if (a === null) throw "a choice question has exactly one answer.";
      if (!inChoices(a)) throw `the answer "${a}" isn't one of its choices.`;
      q.answer = a.trim();
    } else {
      const a = answerMany(q.answer);
      if (!a.length) throw "it has no right answer.";
      const bad = a.find((x) => !inChoices(x));
      if (bad !== undefined) throw `the answer "${bad}" isn't one of its choices.`;
      q.answer = a.map((x) => x.trim());
    }
    keepMisconceptions(q, choices);
  } else if (q.kind === "truefalse") {
    const one = answerOne(q.answer);
    if (one === null) throw "a true or false question has one answer.";
    const tf = trueFalse(one);
    if (tf === null) throw "the answer must be true or false.";
    q.answer = tf;
    q.choices = ["true", "false"];
    delete q.misconceptions;
  } else {
    const a = answerOne(q.answer);
    if (a === null) throw "it has one answer, not a list.";
    if (a.trim() === "") throw "it has no answer.";
    if (q.kind === "cloze" && !(prompt.includes("___") || prompt.includes("{{"))) throw "a fill-in question needs a blank (___) in it.";
    delete q.choices;
    delete q.misconceptions;
  }
}

/** Keeps only misconceptions keyed by one of the choices (trimmed), with text; drops the field when none is left. */
function keepMisconceptions(q: Question, choices: readonly string[]): void {
  const m = q.misconceptions;
  if (!m || typeof m !== "object") {
    delete q.misconceptions;
    return;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    const choice = choices.find((c) => c.trim() === k.trim());
    if (choice !== undefined && typeof v === "string" && v.trim() !== "") out[choice.trim()] = v.trim();
  }
  if (Object.keys(out).length) q.misconceptions = out;
  else delete q.misconceptions;
}

/** The mistake a wrongly picked choice stands for, if the question names one. */
function misconceptionOf(q: Question, picked: string): string | undefined {
  const m = q.misconceptions;
  if (!m) return undefined;
  const hit = Object.entries(m).find(([k]) => k.trim().toLowerCase() === picked.trim().toLowerCase());
  return hit?.[1];
}

function trueFalse(s: string): "true" | "false" | null {
  const a = s.trim().toLowerCase();
  if (a === "true" || a === "t") return "true";
  if (a === "false" || a === "f") return "false";
  return null;
}

const NORM_KEEP = ".-^/∩∪→¬∧∨∈⊆";

/** Lower-case words and numbers only, for comparing typed answers. */
export function norm(s: string): string {
  const lower = s.toLowerCase();
  const words: string[] = [];
  let cur = "";
  const flush = () => {
    const w = trimChars(cur, ".-");
    if (w !== "" && w !== "a" && w !== "an" && w !== "the") words.push(w);
    cur = "";
  };
  for (const c of lower) {
    if (isAlnum(c) || NORM_KEEP.includes(c)) cur += c;
    else flush();
  }
  flush();
  return words.join(" ");
}

export function sameNumber(a: string, b: string): boolean {
  const x = parseRustF64(a.trim());
  const y = parseRustF64(b.trim());
  return x !== null && y !== null && Math.abs(x - y) < 1e-9;
}

function from(q: Question): string {
  if (q.source === undefined) return "";
  const i = q.source.lastIndexOf("/");
  return ` (From ${i < 0 ? q.source : q.source.slice(i + 1)}.)`;
}

function feedback(q: Question, verdict: string): string {
  const expl = q.explanation.trim();
  return verdict + (expl ? " " + expl : "") + from(q);
}

/** Grades a question; `null` for a short answer (the model grades those). */
export function grade(q: Question, given: Answer): QuestionResult | null {
  const expected = q.answer;
  const result = (correct: boolean, partial: number | null, verdict: string): QuestionResult => {
    const fb = feedback(q, verdict);
    // Field order as serde writes it: id, correct, partial?, given, expected, feedback.
    return partial !== null ? { id: q.id, correct, partial, given, expected, feedback: fb } : { id: q.id, correct, given, expected, feedback: fb };
  };
  if (answerMany(given).every((g) => g.trim() === "")) return result(false, null, `No answer given. The answer is ${answerText(expected)}.`);
  switch (q.kind) {
    case "choice":
    case "truefalse": {
      let g = answerOne(given) ?? "";
      const a = answerOne(expected) ?? "";
      // Fixed: a true/false answer typed as t/f grades like it validates.
      if (q.kind === "truefalse") g = trueFalse(g) ?? g;
      if (asciiLower(g.trim()) === asciiLower(a.trim())) return result(true, null, "Right.");
      const why = q.kind === "choice" ? misconceptionOf(q, g) : undefined;
      return result(false, null, `Not quite: the answer is ${a}.${why ? ` ${why}` : ""}`);
    }
    case "multi": {
      // Fixed: repeated picks (or a repeated right answer) count once.
      const right = [...new Set(answerMany(expected).map((s) => s.trim().toLowerCase()))];
      const picked = [...new Set(answerMany(given).map((s) => s.trim().toLowerCase()))];
      const hits = picked.filter((p) => right.includes(p)).length;
      const wrong = picked.filter((p) => !right.includes(p)).length;
      if (hits === right.length && wrong === 0) return result(true, null, "Right: you picked every one.");
      const credit = Math.max((hits - wrong) / right.length, 0);
      const missed = right.length - hits;
      const why: string[] = [];
      if (missed > 0) why.push(`missed ${missed}`);
      if (wrong > 0) why.push(`picked ${wrong} that ${wrong === 1 ? "isn’t right" : "aren’t right"}`);
      const firstWrong = picked.find((p) => !right.includes(p) && misconceptionOf(q, p) !== undefined);
      const mistake = firstWrong !== undefined ? ` ${misconceptionOf(q, firstWrong)}` : "";
      return result(false, credit > 0 ? credit : null, `Partly: you ${why.join(" and ")}. The right ones are ${answerText(expected)}.${mistake}`);
    }
    case "cloze": {
      const g = answerOne(given) ?? answerText(given);
      const accepted = [...answerMany(expected), ...(q.accept ?? [])];
      const gn = norm(g);
      if (accepted.some((a) => norm(a) === gn || sameNumber(a, g))) return result(true, null, "Right.");
      const close = accepted.some((a) => {
        const an = norm(a);
        return charLen(an) >= 6 && levenshtein(an, gn) <= 1;
      });
      return close
        ? result(true, null, `Right (check the spelling: ${answerText(expected)}).`)
        : result(false, null, `Not quite: the answer is ${answerText(expected)}.`);
    }
    default:
      return null;
  }
}

// ---- Reading JSON the way serde did -------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "a sequence";
  if (typeof v === "object") return "a map";
  if (typeof v === "string") return `string ${JSON.stringify(v)}`;
  if (typeof v === "number") return Number.isInteger(v) ? `integer \`${v}\`` : `floating point \`${v}\``;
  if (typeof v === "boolean") return `boolean \`${v}\``;
  return typeof v;
}

function str(o: Obj, k: string, required: boolean, dflt = ""): string {
  const v = o[k];
  if (v === undefined) {
    if (required) throw `missing field \`${k}\``;
    return dflt;
  }
  if (typeof v !== "string") throw `invalid type: ${typeName(v)}, expected a string`;
  return v;
}

function optStr(o: Obj, k: string): string | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw `invalid type: ${typeName(v)}, expected a string`;
  return v;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) throw `invalid type: ${typeName(v)}, expected a sequence`;
  return v.map((x) => {
    if (typeof x !== "string") throw `invalid type: ${typeName(x)}, expected a string`;
    return x;
  });
}

function optStrList(o: Obj, k: string): string[] | undefined {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  return strList(v);
}

function uint(o: Obj, k: string, required: boolean): number {
  const v = o[k];
  if (v === undefined) {
    if (required) throw `missing field \`${k}\``;
    return 0;
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw `invalid type: ${typeName(v)}, expected u64`;
  return v;
}

export function answerFromJson(v: unknown): Answer {
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return [...(v as string[])];
  throw "data did not match any variant of untagged enum Answer";
}

function evidenceFromJson(v: unknown): Evidence {
  if (!isObj(v)) throw `invalid type: ${typeName(v)}, expected struct Evidence`;
  const e: Evidence = { source: str(v, "source", true), quote: str(v, "quote", true) };
  const at = optStr(v, "at");
  if (at !== undefined) e.at = at;
  if (v.picture !== undefined && v.picture !== null) {
    if (typeof v.picture !== "number" || !Number.isInteger(v.picture) || v.picture < 0) throw `invalid type: ${typeName(v.picture)}, expected u32`;
    e.picture = v.picture;
  }
  return e;
}

export function questionFromJson(v: unknown): Question {
  if (!isObj(v)) throw `invalid type: ${typeName(v)}, expected struct Question`;
  if (v.answer === undefined) throw "missing field `answer`";
  const q: Question = {
    id: str(v, "id", false),
    kind: str(v, "kind", true),
    prompt: str(v, "prompt", true),
    answer: answerFromJson(v.answer),
    explanation: "",
  };
  const choices = optStrList(v, "choices");
  if (choices) q.choices = choices;
  const accept = optStrList(v, "accept");
  if (accept) q.accept = accept;
  q.explanation = str(v, "explanation", false);
  const source = optStr(v, "source");
  if (source !== undefined) q.source = source;
  const topic = optStr(v, "topic");
  if (topic !== undefined) q.topic = topic;
  if (v.misconceptions !== undefined && v.misconceptions !== null) {
    if (!isObj(v.misconceptions)) throw `invalid type: ${typeName(v.misconceptions)}, expected a map`;
    const m: Record<string, string> = {};
    for (const [k, x] of Object.entries(v.misconceptions)) {
      if (typeof x !== "string") throw `invalid type: ${typeName(x)}, expected a string`;
      m[k] = x;
    }
    q.misconceptions = m;
  }
  if (v.citations !== undefined) {
    if (!Array.isArray(v.citations)) throw `invalid type: ${typeName(v.citations)}, expected a sequence`;
    const c = v.citations.map(evidenceFromJson);
    if (c.length) q.citations = c;
  }
  return orderQuestion(q);
}

/** Field order as serde writes it. */
export function orderQuestion(q: Question): Question {
  const o: Question = { id: q.id, kind: q.kind, prompt: q.prompt } as Question;
  if (q.choices !== undefined) o.choices = q.choices;
  o.answer = q.answer;
  if (q.accept !== undefined) o.accept = q.accept;
  o.explanation = q.explanation;
  if (q.source !== undefined) o.source = q.source;
  if (q.topic !== undefined) o.topic = q.topic;
  if (q.citations !== undefined && q.citations.length) o.citations = q.citations;
  if (q.misconceptions !== undefined && Object.keys(q.misconceptions).length) o.misconceptions = q.misconceptions;
  return o;
}

/** A quiz file's JSON, checked like serde's derive (missing fields, wrong types). Throws a message. */
export function quizFromJson(v: unknown): Quiz {
  if (!isObj(v)) throw `invalid type: ${typeName(v)}, expected struct Quiz`;
  const title = str(v, "title", true);
  const course = optStr(v, "course");
  const sources = v.sources === undefined ? [] : strList(v.sources);
  const created = uint(v, "created", false);
  if (v.questions === undefined) throw "missing field `questions`";
  if (!Array.isArray(v.questions)) throw `invalid type: ${typeName(v.questions)}, expected a sequence`;
  const questions = v.questions.map(questionFromJson);
  const q: Quiz = { title } as Quiz;
  if (course !== undefined) q.course = course;
  q.sources = sources;
  q.created = created;
  q.questions = questions;
  if (v.grounding !== undefined && v.grounding !== null) {
    if (!isObj(v.grounding)) throw `invalid type: ${typeName(v.grounding)}, expected struct Grounding`;
    q.grounding = v.grounding as unknown as Grounding;
  }
  return q;
}

/** The quiz in serde's field order, for writing. */
export function orderQuiz(q: Quiz): Quiz {
  const o = { title: q.title } as Quiz;
  if (q.course !== undefined) o.course = q.course;
  o.sources = q.sources;
  o.created = q.created;
  o.questions = q.questions.map(orderQuestion);
  if (q.grounding !== undefined) o.grounding = q.grounding;
  return o;
}

function resultFromJson(v: unknown): QuestionResult {
  if (!isObj(v)) throw `invalid type: ${typeName(v)}, expected struct QuestionResult`;
  const id = str(v, "id", true);
  if (v.correct === undefined) throw "missing field `correct`";
  if (typeof v.correct !== "boolean") throw `invalid type: ${typeName(v.correct)}, expected a boolean`;
  const r: QuestionResult = { id, correct: v.correct } as QuestionResult;
  if (v.partial !== undefined && v.partial !== null) {
    if (typeof v.partial !== "number") throw `invalid type: ${typeName(v.partial)}, expected f64`;
    r.partial = v.partial;
  }
  if (v.given === undefined) throw "missing field `given`";
  r.given = answerFromJson(v.given);
  if (v.expected === undefined) throw "missing field `expected`";
  r.expected = answerFromJson(v.expected);
  r.feedback = str(v, "feedback", true);
  if (v.ungraded !== undefined) {
    if (typeof v.ungraded !== "boolean") throw `invalid type: ${typeName(v.ungraded)}, expected a boolean`;
    if (v.ungraded) r.ungraded = true;
  }
  return r;
}

export function attemptFromJson(v: unknown): Attempt {
  if (!isObj(v)) throw `invalid type: ${typeName(v)}, expected struct Attempt`;
  const path = str(v, "path", true);
  const quiz = str(v, "quiz", true);
  const taken = uint(v, "taken", true);
  if (v.score === undefined) throw "missing field `score`";
  if (typeof v.score !== "number") throw `invalid type: ${typeName(v.score)}, expected f64`;
  if (v.results === undefined) throw "missing field `results`";
  if (!Array.isArray(v.results)) throw `invalid type: ${typeName(v.results)}, expected a sequence`;
  return { path, quiz, taken, score: v.score, results: v.results.map(resultFromJson) };
}
