/**
 * Taking a quiz one question at a time, and reading its results: which key
 * does what on a question, how sure the person said they were, the score by
 * topic, and the order to review misses in (sure-but-wrong first: those are
 * the misconceptions). Pure (quiz-results.test.ts).
 */
import { type Answer, answerList, choicesOf, isAnswered, sameAnswer, verdictOf, type Verdict } from "./quiz-answers";
import type { Question, QuestionResult } from "./types";

/** How sure the person was of an answer; asked lightly, never required. */
export type Sure = "guess" | "unsure" | "sure";
export const SURE: { value: Sure; label: string; key: string }[] = [
  { value: "guess", label: "Guessing", key: "g" },
  { value: "unsure", label: "Unsure", key: "u" },
  { value: "sure", label: "Sure", key: "s" },
];

export type KeyAction =
  | { kind: "answer"; answer: Answer }
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "flag" }
  | { kind: "sure"; sure: Sure }
  | null;

/**
 * What a key press means on a question, when focus isn't in a text field:
 * 1–9 pick (or, on select-all, toggle) a choice, Enter and → go on, ← goes
 * back, F flags, G/U/S say how sure.
 */
export function keyAction(key: string, q: Pick<Question, "kind" | "choices">, current: Answer | undefined): KeyAction {
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (k === "Enter" || k === "ArrowRight") return { kind: "next" };
  if (k === "ArrowLeft") return { kind: "prev" };
  if (k === "f") return { kind: "flag" };
  const sure = SURE.find((s) => s.key === k);
  if (sure) return { kind: "sure", sure: sure.value };
  if (/^[1-9]$/.test(k) && q.kind !== "short" && q.kind !== "cloze") {
    const choice = choicesOf(q)[Number(k) - 1];
    if (choice === undefined) return null;
    if (q.kind !== "multi") return { kind: "answer", answer: choice };
    const list = answerList(current);
    return { kind: "answer", answer: list.some((x) => sameAnswer(x, choice)) ? list.filter((x) => !sameAnswer(x, choice)) : [...list, choice] };
  }
  return null;
}

/** Where to go from question `at` when moving on: the next one, or -1 at the end. */
export function nextIndex(at: number, total: number): number {
  return at + 1 < total ? at + 1 : -1;
}

/** Questions not answered and questions flagged, for the check before grading. */
export function beforeCheck(ids: readonly string[], answers: Record<string, Answer>, flagged: readonly string[]): { unanswered: number[]; flagged: number[] } {
  const unanswered: number[] = [];
  const marked: number[] = [];
  ids.forEach((id, i) => {
    if (!isAnswered(answers[id])) unanswered.push(i);
    if (flagged.includes(id)) marked.push(i);
  });
  return { unanswered, flagged: marked };
}

export type TopicScore = { topic: string; asked: number; points: number; graded: number; percent: number | null };

/** The score per topic, weakest first (topics with nothing graded last). Untagged questions share "Other". */
export function topicBreakdown(questions: readonly Pick<Question, "id" | "topic">[], results: readonly QuestionResult[]): TopicScore[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  const map = new Map<string, TopicScore>();
  for (const q of questions) {
    const r = byId.get(q.id);
    if (!r) continue;
    const topic = q.topic?.split(" (")[0]?.trim() || "Other";
    const t = map.get(topic) ?? { topic, asked: 0, points: 0, graded: 0, percent: null };
    t.asked++;
    if (!r.ungraded) {
      t.graded++;
      t.points += r.correct ? 1 : (r.partial ?? 0);
    }
    map.set(topic, t);
  }
  const out = [...map.values()].map((t) => ({ ...t, percent: t.graded ? (t.points / t.graded) * 100 : null }));
  return out.sort((a, b) => (a.percent == null ? 1 : b.percent == null ? -1 : a.percent - b.percent) || a.topic.localeCompare(b.topic));
}

export type ReviewItem = { id: string; index: number; verdict: Verdict; sure?: Sure; why: "confident-miss" | "miss" | "partial" | "lucky" | "ungraded" };

/**
 * What to go over, in order: wrong answers given with confidence (a
 * misconception), other wrong answers, partly right, then right answers
 * that were guesses (luck, not knowledge), then ungraded ones.
 */
export function reviewList(questions: readonly Pick<Question, "id">[], results: readonly QuestionResult[], sure: Readonly<Record<string, Sure>>): ReviewItem[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  const rank: Record<ReviewItem["why"], number> = { "confident-miss": 0, miss: 1, partial: 2, lucky: 3, ungraded: 4 };
  const out: ReviewItem[] = [];
  questions.forEach((q, index) => {
    const r = byId.get(q.id);
    if (!r) return;
    const verdict = verdictOf(r);
    const s = sure[q.id];
    let why: ReviewItem["why"] | null = null;
    if (verdict === "wrong") why = s === "sure" ? "confident-miss" : "miss";
    else if (verdict === "partial") why = s === "sure" ? "confident-miss" : "partial";
    else if (verdict === "correct" && s === "guess") why = "lucky";
    else if (verdict === "ungraded") why = "ungraded";
    if (why) out.push({ id: q.id, index, verdict, sure: s, why });
  });
  return out.sort((a, b) => rank[a.why] - rank[b.why] || a.index - b.index);
}

export const WHY_WORDS: Record<ReviewItem["why"], string> = {
  "confident-miss": "You were sure",
  miss: "Missed",
  partial: "Partly right",
  lucky: "Right, but a guess",
  ungraded: "Not graded",
};

/** The questions to retake: every graded miss (wrong or partly right). */
export const missedIds = (results: readonly QuestionResult[]) => results.filter((r) => !r.ungraded && !r.correct).map((r) => r.id);
