import { BACK_MAX, FRONT_MAX, clozeAnswers, kindOf } from "./deck.ts";
import { answerMany, answerText, checkQuestion, norm, orderQuestion } from "./quiz.ts";

export { orderQuestion };
import type { Material } from "./sources.ts";
import { baseName, charLen, isAlnum, splitBy } from "./text.ts";
import type { Answer, Attempt, Note, Question, QuestionResult, Quiz } from "./types.ts";

/**
 * Turning one written item (a model's JSON) into a question or card, with the
 * mechanical checks every item passes before the independent judge sees it
 * (Rust generate.rs: question_from, card_from, check_quality, about_files).
 */

/** A string field: trimmed text, or a number/bool as text, else "". */
export function strField(v: unknown, k: string): string {
  const x = (v as Record<string, unknown> | null)?.[k];
  if (typeof x === "string") return x.trim();
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  return "";
}

/** Like strField without bools (Rust `str_of`). */
export function strOf(v: unknown, k: string): string {
  const x = (v as Record<string, unknown> | null)?.[k];
  if (typeof x === "string") return x.trim();
  if (typeof x === "number") return String(x);
  return "";
}

function words(s: string): string[] {
  return splitBy(s.toLowerCase(), (c) => !isAlnum(c)).filter((w) => w !== "");
}

/** Two fronts or prompts that ask the same thing (same words, or ≥80% overlap of ≥4 distinct words each). */
export function similar(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === wb.length && wa.every((w, i) => w === wb[i])) return true;
  const sa = new Set(wa);
  const sb = new Set(wb);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = new Set([...sa, ...sb]).size;
  return sa.size >= 4 && sb.size >= 4 && union > 0 && inter / union >= 0.8;
}

/** Inside $…$, a `{{` or `}}` gets a space so LaTeX never reads as a fill-in blank. */
export function spaceMathBraces(s: string): string {
  let out = "";
  let inMath = false;
  let prev = "\0";
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === "$" && prev !== "\\") inMath = !inMath;
    out += c;
    if (inMath && (c === "}" || c === "{") && chars[i + 1] === c) out += " ";
    prev = c;
  }
  return out;
}

const LOGISTICS = ["due date", "office hours", "late policy", "late penalty", "grading policy", "which file", "which lecture", "file name"];

/** Why a question or card is about the files or the course's logistics instead of the material, if it is. */
export function aboutFiles(text: string, m: Material): string | null {
  const lower = text.toLowerCase();
  for (const label of m.labels) {
    const name = baseName(label).toLowerCase();
    const dot = name.lastIndexOf(".");
    const stem = dot >= 0 ? name.slice(0, dot) : name;
    if (charLen(stem) >= 6 && lower.includes(stem)) return `asks about the file “${baseName(label)}”; ask about the ideas in it instead`;
  }
  const w = LOGISTICS.find((x) => lower.includes(x));
  if (w) return `is about course logistics (“${w}”), not the material`;
  if ([".pdf", ".docx", ".pptx"].some((ext) => lower.includes(ext))) return "names a file; ask about the ideas instead";
  return null;
}

/** Card from one written item, or a reason (`card {n} …`). */
export function cardFrom(c: unknown, n: number, m: Material, source: string | undefined): Note {
  const note: Note = { front: spaceMathBraces(strField(c, "front")), back: spaceMathBraces(strField(c, "back")) };
  if (source !== undefined) note.source = source;
  if (note.front === "") throw `card ${n} has no front`;
  if (charLen(note.front) > FRONT_MAX || charLen(note.back) > BACK_MAX) throw `card ${n} is too long`;
  if (kindOf(note.front) === "cloze") {
    try {
      clozeAnswers(note.front);
    } catch (e) {
      throw `card ${n}: ${typeof e === "string" ? e : (e as Error).message}`;
    }
  } else if (note.back === "") throw `card ${n} has no back`;
  else if (note.front.includes("}}")) throw `card ${n} has a stray }}`;
  const why = aboutFiles(note.front, m);
  if (why) throw `card ${n} ${why}`;
  return note;
}

function checkQuality(q: Question): void {
  const choices = q.choices ?? [];
  if (q.kind === "choice" || q.kind === "multi") {
    if (choices.length < 3) throw "needs at least 3 choices";
    if (choices.some((c) => /all of the above|none of the above|both a and b/.test(c.toLowerCase()))) throw "uses “all/none of the above”; give real choices";
    if (q.kind === "multi") {
      const right = answerMany(q.answer);
      if (new Set(right.map((a) => a.trim().toLowerCase())).size !== right.length) throw "lists the same right answer twice";
      if (right.length >= choices.length) throw "has every choice right; at least one must be wrong";
    }
  } else if (q.kind === "cloze") {
    const count = (s: string, pat: string) => s.split(pat).length - 1;
    if (Math.max(count(q.prompt, "___"), count(q.prompt, "{{")) !== 1) throw "needs exactly one blank (___)";
    const a = norm(answerText(q.answer));
    if (charLen(a) >= 4 && norm(q.prompt.replaceAll("___", " ")).includes(a)) throw "gives its answer away in the sentence";
  }
}

/** Each wrong choice's mistake, keyed by the choice as stored; only wrong choices of choice/multi questions. */
function misconceptionsOf(raw: unknown, q: Question): Record<string, string> | undefined {
  if ((q.kind !== "choice" && q.kind !== "multi") || !q.choices) return undefined;
  const m = (raw as Record<string, unknown> | null)?.misconceptions;
  if (!m || typeof m !== "object" || Array.isArray(m)) return undefined;
  const right = new Set(answerMany(q.answer).map((a) => a.trim()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (typeof v !== "string" || v.trim() === "") continue;
    const choice = q.choices.find((c) => c.trim() === k.trim());
    if (choice !== undefined && !right.has(choice.trim())) out[choice] = v.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/** Question from one written item, or a reason (`question {n} …`). */
export function questionFrom(raw: unknown, n: number, m: Material, kinds: readonly string[], source: string | undefined): Question {
  const r = (raw ?? {}) as Record<string, unknown>;
  const a = r.answer;
  let answer: Answer;
  if (Array.isArray(a)) answer = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
  else if (typeof a === "boolean") answer = String(a);
  else if (a === null || a === undefined) throw `question ${n} has no answer`;
  else answer = typeof a === "string" ? a : JSON.stringify(a);
  const list = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.trim()) : undefined);
  const q: Question = { id: `q${n}`, kind: strField(r, "kind"), prompt: strField(r, "prompt"), answer, explanation: strField(r, "explanation") };
  const choices = list("choices");
  if (choices) q.choices = choices;
  const accept = list("accept");
  if (accept?.length) q.accept = accept;
  if (source !== undefined) q.source = source;
  if (!kinds.includes(q.kind)) throw `question ${n} is a "${q.kind}" question, but only these kinds were asked for: ${kinds.join(", ")}`;
  try {
    checkQuestion(q);
  } catch (e) {
    throw `question ${n}: ${typeof e === "string" ? e : (e as Error).message}`;
  }
  if (q.kind !== "cloze") delete q.accept;
  if (q.explanation === "") throw `question ${n} has no explanation`;
  try {
    checkQuality(q);
  } catch (e) {
    throw `question ${n} ${typeof e === "string" ? e : (e as Error).message}`;
  }
  const why = aboutFiles(`${q.prompt} ${(q.choices ?? []).join(" ")}`, m);
  if (why) throw `question ${n} ${why}`;
  const mis = misconceptionsOf(raw, q);
  if (mis) q.misconceptions = mis;
  else delete q.misconceptions;
  return orderQuestion(q);
}

/** xorshift Fisher–Yates over u64, exactly as Rust (`seed` threads through calls). */
export function shuffle<T>(v: T[], seed: { value: bigint }): void {
  const MASK = 0xffffffffffffffffn;
  for (let i = v.length - 1; i >= 1; i--) {
    let s = seed.value;
    s ^= (s << 13n) & MASK;
    s ^= s >> 7n;
    s ^= (s << 17n) & MASK;
    seed.value = s;
    const j = Number(s % BigInt(i + 1));
    [v[i], v[j]] = [v[j]!, v[i]!];
  }
}

export function shuffleChoices(q: Question, seed: { value: bigint }): void {
  if ((q.kind === "choice" || q.kind === "multi") && q.choices) shuffle(q.choices, seed);
}

/** Results marked wrong (and graded), joined to their questions. */
export function mistakes(quiz: Quiz, attempt: Attempt): [Question, QuestionResult][] {
  const out: [Question, QuestionResult][] = [];
  for (const r of attempt.results) {
    if (r.correct || r.ungraded) continue;
    const q = quiz.questions.find((x) => x.id === r.id);
    if (q) out.push([q, r]);
  }
  return out;
}

export function mistakesBlock(list: readonly [Question, QuestionResult][]): string {
  let s = "<mistakes>\n";
  for (const [q, r] of list) {
    const given = answerText(r.given);
    s += `- Question: ${q.prompt}\n  Their answer: ${given.trim() === "" ? "(blank)" : given}\n  Right answer: ${answerText(q.answer)}\n  Why: ${q.explanation}\n  Source: ${q.source ?? "unknown"}\n`;
  }
  return s + "</mistakes>";
}
