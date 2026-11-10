import { describe, expect, it } from "vitest";
import { checkQuestion, grade, normalize, orderQuiz, quizFromJson, score } from "./quiz.ts";
import type { Answer, Question, QuestionResult, Quiz } from "./types.ts";

function q(kind: string, choices: string[] | null, answer: Answer): Question {
  const out: Question = {
    id: "q1",
    kind,
    prompt: "Which ___ is it?",
    answer,
    explanation: "Because the notes say so.",
    source: "courses/C241/files/Notes/notes.pdf",
  };
  if (choices) out.choices = choices;
  return out;
}
const err = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return String(e);
  }
  throw new Error("expected an error");
};

describe("quiz", () => {
  it("choice and truefalse", () => {
    const c = q("choice", ["A set", "A graph", "A tree"], "A graph");
    let r = grade(c, "a graph")!;
    expect(r.correct).toBe(true);
    expect(r.feedback).toBe("Right. Because the notes say so. (From notes.pdf.)");
    r = grade(c, "A set")!;
    expect(r.correct).toBe(false);
    expect(r.feedback.startsWith("Not quite: the answer is A graph.")).toBe(true);
    const tf = q("truefalse", null, true);
    checkQuestion(tf);
    expect(tf.answer).toBe("true");
    expect(grade(tf, "True")!.correct).toBe(true);
    expect(grade(tf, "false")!.correct).toBe(false);
    expect(grade(tf, "  ")!.feedback).not.toBe("");
  });

  it("true/false accepts t and f when grading too (fixed)", () => {
    const tf = q("truefalse", null, "true");
    checkQuestion(tf);
    expect(grade(tf, "t")!.correct).toBe(true);
    expect(grade(tf, "F")!.correct).toBe(false);
  });

  it("multi gives partial credit", () => {
    const m = q("multi", ["1", "2", "3", "4"], ["1", "2", "3"]);
    expect(grade(m, ["3", "1", "2"])!.correct).toBe(true);
    let r = grade(m, ["1", "2"])!;
    expect(r.correct).toBe(false);
    expect(Math.abs(r.partial! - 2 / 3)).toBeLessThan(1e-9);
    expect(r.feedback).toContain("missed 1");
    r = grade(m, ["1", "4"])!;
    expect(r.partial).toBeUndefined();
    expect(r.feedback).toContain("picked 1 that isn’t right");
  });

  it("repeated picks count once and never crash (fixed)", () => {
    const m = q("multi", ["a", "b", "c"], ["a", "b"]);
    const r = grade(m, ["a", "a"])!;
    expect(r.correct).toBe(false);
    expect(r.partial).toBe(0.5);
    expect(r.feedback).toContain("missed 1");
    expect(grade(m, ["a", "a", "a"])!.correct).toBe(false);
    // A repeated right answer doesn't make the question unwinnable.
    expect(grade(q("multi", ["a", "b", "c"], ["a", "a", "b"]), ["a", "b"])!.correct).toBe(true);
  });

  it("cloze forgives case, articles, numbers and one typo", () => {
    const c = q("cloze", null, "the chromatic number");
    c.accept = ["χ(G)"];
    for (const ok of ["Chromatic Number", "chromatic  number.", "chromatc number", "χ(G)"]) expect(grade(c, ok)!.correct, ok).toBe(true);
    expect(grade(c, "clique number")!.correct).toBe(false);
    const n = q("cloze", null, "2");
    expect(grade(n, "2.0")!.correct).toBe(true);
    expect(grade(n, "3")!.correct).toBe(false);
    expect(grade(q("short", null, "x"), "y")).toBeNull();
  });

  it("validation says what is wrong", () => {
    const bad: Quiz = { title: "t", sources: [], created: 0, questions: [q("choice", ["a", "b"], "c")] };
    expect(err(() => normalize(bad))).toContain("isn't one of its choices");
    bad.questions[0] = q("essay", null, "x");
    expect(err(() => normalize(bad))).toContain("isn't a kind");
    bad.questions[0] = q("multi", ["a", "A "], ["a"]);
    expect(err(() => normalize(bad))).toContain("two choices are the same");
    bad.questions[0] = q("cloze", null, "x");
    bad.questions[0]!.prompt = "no blank";
    expect(err(() => normalize(bad))).toContain("blank");
    const text = '{"title":"T","questions":[{"kind":"truefalse","prompt":"p?","answer":false},{"id":"","kind":"short","prompt":"Why?","answer":"Because."}]}';
    const quiz = quizFromJson(JSON.parse(text));
    normalize(quiz);
    expect(quiz.questions.map((x) => x.id)).toEqual(["q1", "q2"]);
    const back = quizFromJson(JSON.parse(JSON.stringify(orderQuiz(quiz))));
    expect(back).toEqual(quiz);
  });

  it("serde-like reading refuses numbers and missing fields", () => {
    expect(err(() => quizFromJson({ title: "T", questions: [{ kind: "short", prompt: "p", answer: 3 }] }))).toContain("did not match any variant");
    expect(err(() => quizFromJson({ questions: [] }))).toContain("missing field `title`");
  });

  it("score leaves out ungraded", () => {
    const r = (correct: boolean, partial: number | undefined, ungraded: boolean): QuestionResult => ({
      id: "x",
      correct,
      ...(partial !== undefined ? { partial } : {}),
      given: "",
      expected: "",
      feedback: "",
      ...(ungraded ? { ungraded } : {}),
    });
    expect(score([r(true, undefined, false), r(false, 0.5, false), r(false, undefined, true)])).toBe(0.75);
    expect(score([r(false, undefined, true)])).toBe(0);
  });

  it("misconceptions are kept for real choices and named when that choice is picked", () => {
    const c = q("choice", ["p → q", "q → p", "¬p → ¬q"], "q → p");
    c.misconceptions = { " p → q ": "Reading “necessary” as “sufficient” reverses the arrow.", nope: "dropped", "¬p → ¬q": "  " };
    checkQuestion(c);
    expect(c.misconceptions).toEqual({ "p → q": "Reading “necessary” as “sufficient” reverses the arrow." });
    const r = grade(c, "p → q")!;
    expect(r.feedback).toBe("Not quite: the answer is q → p. Reading “necessary” as “sufficient” reverses the arrow. Because the notes say so. (From notes.pdf.)");
    expect(grade(c, "¬p → ¬q")!.feedback).toBe("Not quite: the answer is q → p. Because the notes say so. (From notes.pdf.)");
    const short = q("short", null, "x");
    short.misconceptions = { a: "b" };
    checkQuestion(short);
    expect(short.misconceptions).toBeUndefined();
    const none = q("choice", ["a", "b"], "a");
    none.misconceptions = { zz: "x" };
    checkQuestion(none);
    expect(none.misconceptions).toBeUndefined();
  });

  it("multi names the mistake behind the first wrong pick that has one", () => {
    const m = q("multi", ["1", "2", "3", "4"], ["1", "2"]);
    m.misconceptions = { "4": "4 isn’t prime: it is 2 × 2.", "3": "3 is odd." };
    checkQuestion(m);
    const r = grade(m, ["1", "4", "3"])!;
    expect(r.feedback).toBe("Partly: you missed 1 and picked 2 that aren’t right. The right ones are 1, 2. 4 isn’t prime: it is 2 × 2. Because the notes say so. (From notes.pdf.)");
  });
});
