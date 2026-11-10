/**
 * Plain helpers for taking a quiz: the letter of a choice, the choices a
 * question offers, how a given answer compares with a choice (the core folds
 * case and spaces the same way), how a result reads, an exam's scope said
 * once, which question is next without an answer, and the answers kept on
 * this computer until they are checked.
 */
import type { GivenAnswer, Question, QuestionResult } from "./types";

export type Answer = string | string[];
export type Answers = Record<string, Answer>;

/** A, B, C … for the choices, as a printed test letters them. */
export const choiceLetter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

export const isAnswered = (a: Answer | undefined) => (Array.isArray(a) ? a.length > 0 : !!a?.trim());

/** The same answer as the core compares it: trimmed, case folded. */
export const sameAnswer = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The choices a question offers. A true/false question the core normalized
 * has `["true","false"]`; one with none listed gets them too.
 */
export function choicesOf(q: Pick<Question, "kind" | "choices">): string[] {
  if (q.kind === "truefalse") return q.choices?.length ? q.choices : ["true", "false"];
  return q.choices ?? [];
}

/** A choice as shown: true/false read "True" / "False" whatever case the file uses. */
export function choiceLabel(q: Pick<Question, "kind">, choice: string): string {
  if (q.kind === "truefalse" && /^(true|false)$/i.test(choice.trim())) {
    const t = choice.trim().toLowerCase();
    return t[0]!.toUpperCase() + t.slice(1);
  }
  return choice;
}

/** A wire answer as a list of strings (a bool reads "true" / "false"). */
export function answerList(a: GivenAnswer | undefined): string[] {
  if (a == null) return [];
  if (typeof a === "boolean") return [String(a)];
  return (Array.isArray(a) ? a : [a]).filter((s) => s.trim() !== "");
}

/** Whether `choice` is among the answers in `a`. */
export const includesAnswer = (a: GivenAnswer | undefined, choice: string) => answerList(a).some((x) => sameAnswer(x, choice));

export type Verdict = "correct" | "partial" | "wrong" | "ungraded";

/** How a result reads: right, partly right, not right, or not graded (left out of the score). */
export function verdictOf(r: Pick<QuestionResult, "correct" | "partial" | "ungraded">): Verdict {
  if (r.ungraded) return "ungraded";
  if (r.correct) return "correct";
  if (r.partial != null && r.partial > 0) return "partial";
  return "wrong";
}

/**
 * The points of an attempt as the core scores it: a graded result is worth 1
 * (correct), its partial credit, or 0; an ungraded one is left out of both
 * the points and the total, so the heading agrees with `attempt.score`.
 */
export function attemptPoints(results: readonly Pick<QuestionResult, "correct" | "partial" | "ungraded">[]): {
  points: number;
  total: number;
  ungraded: number;
} {
  let points = 0;
  let total = 0;
  let ungraded = 0;
  for (const r of results) {
    if (r.ungraded) {
      ungraded++;
      continue;
    }
    total++;
    points += r.correct ? 1 : (r.partial ?? 0);
  }
  return { points, total, ungraded };
}

/** "7" or "7.5": points to one decimal, none when whole. */
export function pointsText(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1);
}

/** The scope's parts said once ("no graphs; not graphs" keeps only the first). */
export function tidyScope(scope: string): string {
  const seen = new Set<string>();
  return scope
    .split(/\s*;\s*/)
    .filter((p) => {
      const key = p.toLowerCase().replace(/^(no|not)\s+/, "not ").replace(/[.\s]+$/, "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("; ");
}

/** The first question without an answer after `from` (an index), wrapping round; -1 when every one has one. */
export function nextUnanswered(ids: string[], answers: Answers, from: number): number {
  for (let k = 1; k <= ids.length; k++) {
    const i = (from + k) % ids.length;
    if (!isAnswered(answers[ids[i]!])) return i;
  }
  return -1;
}

/** "4, 8 and 19". */
export function listWords(items: (string | number)[]): string {
  const s = items.map(String);
  return s.length <= 1 ? (s[0] ?? "") : `${s.slice(0, -1).join(", ")} and ${s[s.length - 1]}`;
}

const draftKey = (space: string, path: string) => `phaethon.quiz-draft:${space}:${path}`;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Answers not yet checked, for this quiz as it was made (`created`): a quiz made again under the same name starts empty. */
export function loadDraft(space: string, path: string, created: number, ids: string[]): Answers {
  try {
    const raw = storage()?.getItem(draftKey(space, path));
    if (!raw) return {};
    const d = JSON.parse(raw) as { created?: number; answers?: Answers };
    if (d.created !== created || !d.answers || typeof d.answers !== "object") {
      storage()?.removeItem(draftKey(space, path));
      return {};
    }
    const known = new Set(ids);
    return Object.fromEntries(
      Object.entries(d.answers).filter(
        ([id, a]) => known.has(id) && (typeof a === "string" || (Array.isArray(a) && a.every((x) => typeof x === "string"))),
      ),
    );
  } catch {
    return {};
  }
}

export function saveDraft(space: string, path: string, created: number, answers: Answers): void {
  try {
    if (Object.values(answers).some(isAnswered)) storage()?.setItem(draftKey(space, path), JSON.stringify({ created, answers }));
    else storage()?.removeItem(draftKey(space, path));
  } catch {
    // Storage full or blocked: the answers still stand on the page.
  }
}

export function clearDraft(space: string, path: string): void {
  try {
    storage()?.removeItem(draftKey(space, path));
  } catch {
    // Nothing to clear.
  }
}

/** How many answers wait in a draft, for the hub's row. */
export function draftCount(space: string, path: string): number {
  try {
    const raw = storage()?.getItem(draftKey(space, path));
    if (!raw) return 0;
    const d = JSON.parse(raw) as { answers?: Answers };
    return Object.values(d.answers ?? {}).filter(isAnswered).length;
  } catch {
    return 0;
  }
}
