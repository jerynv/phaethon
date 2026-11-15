import { describe, expect, test } from "vitest";
import { beforeCheck, keyAction, missedIds, nextIndex, reviewList, topicBreakdown } from "./quiz-results";
import type { QuestionResult } from "./types";

const choice = { kind: "choice" as const, choices: ["a", "b", "c", "d"] };
const multi = { kind: "multi" as const, choices: ["a", "b", "c"] };
const r = (id: string, correct: boolean, more: Partial<QuestionResult> = {}): QuestionResult => ({ id, correct, given: "", expected: "", feedback: "", ...more });

describe("keys on a question", () => {
  test("numbers pick a choice; on select-all they toggle", () => {
    expect(keyAction("2", choice, undefined)).toEqual({ kind: "answer", answer: "b" });
    expect(keyAction("5", choice, undefined)).toBeNull();
    expect(keyAction("1", multi, ["b"])).toEqual({ kind: "answer", answer: ["b", "a"] });
    expect(keyAction("2", multi, ["b", "a"])).toEqual({ kind: "answer", answer: ["a"] });
    expect(keyAction("1", { kind: "truefalse" }, undefined)).toEqual({ kind: "answer", answer: "true" });
    expect(keyAction("1", { kind: "short" }, undefined)).toBeNull();
  });

  test("moving, flagging and how sure", () => {
    expect(keyAction("Enter", choice, "a")).toEqual({ kind: "next" });
    expect(keyAction("ArrowRight", choice, undefined)).toEqual({ kind: "next" });
    expect(keyAction("ArrowLeft", choice, undefined)).toEqual({ kind: "prev" });
    expect(keyAction("F", choice, undefined)).toEqual({ kind: "flag" });
    expect(keyAction("s", choice, undefined)).toEqual({ kind: "sure", sure: "sure" });
    expect(keyAction("g", choice, undefined)).toEqual({ kind: "sure", sure: "guess" });
    expect(keyAction("x", choice, undefined)).toBeNull();
    expect([nextIndex(0, 3), nextIndex(2, 3)]).toEqual([1, -1]);
  });

  test("before checking: what's unanswered and what's flagged", () => {
    expect(beforeCheck(["q1", "q2", "q3"], { q1: "a", q2: [], q3: " " }, ["q1"])).toEqual({ unanswered: [1, 2], flagged: [0] });
  });
});

describe("results", () => {
  const qs = [
    { id: "q1", topic: "Power sets (§2.1)" },
    { id: "q2", topic: "Functions" },
    { id: "q3", topic: "Power sets" },
    { id: "q4" },
    { id: "q5", topic: "Functions" },
  ];
  const results = [r("q1", true), r("q2", false), r("q3", false, { partial: 0.5 }), r("q4", false, { ungraded: true }), r("q5", true)];

  test("by topic, weakest first, ungraded left out of the score", () => {
    expect(topicBreakdown(qs, results)).toEqual([
      { topic: "Functions", asked: 2, points: 1, graded: 2, percent: 50 },
      { topic: "Power sets", asked: 2, points: 1.5, graded: 2, percent: 75 },
      { topic: "Other", asked: 1, points: 0, graded: 0, percent: null },
    ]);
  });

  test("review order: confident misses, misses, partly right, lucky guesses, ungraded", () => {
    const list = reviewList(qs, results, { q2: "unsure", q3: "sure", q5: "guess" });
    expect(list.map((x) => [x.id, x.why])).toEqual([
      ["q3", "confident-miss"],
      ["q2", "miss"],
      ["q5", "lucky"],
      ["q4", "ungraded"],
    ]);
    expect(missedIds(results)).toEqual(["q2", "q3"]);
  });
});
