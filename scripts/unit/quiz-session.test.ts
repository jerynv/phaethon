import assert from "node:assert/strict";
import { test } from "node:test";
import { loadQuizSession, questionHelpContext, saveQuizSession } from "../../src/components/study/quiz-session.ts";

test("quiz layout, current question and flags survive leaving the workspace, without crossing quiz revisions", () => {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  try {
    saveQuizSession("school", "study/quizzes/test.json", 42, { layout: "all", flagged: ["q2", "q2", "removed"], at: 99 });
    assert.deepEqual(loadQuizSession("school", "study/quizzes/test.json", 42, ["q1", "q2"]), { layout: "all", flagged: ["q2"], at: 1 });
    assert.deepEqual(loadQuizSession("school", "study/quizzes/test.json", 43, ["q1", "q2"]), { layout: "single", flagged: [], at: 0 });
    assert.deepEqual(loadQuizSession("work", "study/quizzes/test.json", 42, ["q1", "q2"]), { layout: "single", flagged: [], at: 0 });
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("AI question help carries course material, question and student answer without leaking grading fields", () => {
  const quiz = { title: "Functions", course: "Discrete mathematics", sources: ["courses/Discrete/notes.md"] };
  const question = { kind: "choice", prompt: "Which function is injective?", choices: ["f(x)=x", "f(x)=0"], answer: "secret expected answer", explanation: "secret grading explanation" };
  const context = questionHelpContext(quiz, "study/quizzes/Functions.json", question, "f(x)=0");
  assert.match(context, /Discrete mathematics/);
  assert.match(context, /Which function is injective/);
  assert.match(context, /A\. f\(x\)=x; B\. f\(x\)=0/);
  assert.match(context, /My current answer: f\(x\)=0/);
  assert.match(context, /courses\/Discrete\/notes.md/);
  assert.match(context, /Ask guiding questions/);
  assert.doesNotMatch(context, /secret/);
});
