// node --test scripts/unit/
import assert from "node:assert/strict";
import { test } from "node:test";

import { planSentence, questionBefore, readBlock, type StudyPlan } from "../../src/lib/study-chat.ts";
import { mathAsText, mathPieces } from "../../src/lib/study-math.ts";

test("a block is read only once it is whole and the reply has ended", () => {
  const block = '{"kind": "quiz", "count": 10}';
  assert.deepEqual(readBlock('{"kind": "qu', false), { state: "writing" });
  assert.deepEqual(readBlock(block, false), { state: "writing" }, "parses mid-stream, but the reply may still change");
  assert.deepEqual(readBlock(block, true), { state: "ok", block, kind: "quiz" });
  assert.equal((readBlock('{"kind": "flashcards"}', true) as { kind: string }).kind, "deck");
  assert.equal(readBlock('{"kind": "qu', true).state, "invalid");
  assert.equal(readBlock("[1, 2]", true).state, "invalid");
  assert.equal(readBlock('"quiz"', true).state, "invalid");
  assert.equal(readBlock('{"kind": "essay"}', true).state, "invalid");
  assert.equal(readBlock('{"kind": "essay"}', false).state, "invalid", "a wrong kind is wrong at once");
  assert.equal(readBlock(`{"kind": "quiz", "x": "${"a".repeat(9000)}"}`, true).state, "invalid");
});

test("the plan in plain words", () => {
  const p: StudyPlan = {
    origin: "o",
    kind: "quiz",
    count: 10,
    kinds: ["choice", "truefalse", "short"],
    difficulty: "exam",
    focus: "eigenvalues",
    sources: [{ path: "courses/M301", name: "MATH-M 301" }],
    unknown: [],
    notes: [],
    running: false,
  };
  assert.equal(planSentence(p), "A quiz of 10 questions on eigenvalues (multiple choice, true or false and short answer), exam level, from MATH-M 301.");
  assert.equal(planSentence({ ...p, kind: "deck", count: 1, focus: undefined }), "A deck of 1 card, from MATH-M 301.");
});

test("the question is the user message before the reply", () => {
  const msgs = [
    { id: "u1", role: "user", content: [{ type: "text", text: "first" }] },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "x" }] },
    { id: "u2", role: "user", content: [{ type: "text", text: "quiz me" }] },
    { id: "a2", role: "assistant", content: [{ type: "text", text: "y" }] },
  ];
  assert.equal(questionBefore(msgs, "a2"), "quiz me");
  assert.equal(questionBefore(msgs, "a1"), "first");
  assert.equal(questionBefore(msgs, "missing"), "quiz me");
});

test("math is split from text, and a dollar amount stays text", () => {
  assert.deepEqual(mathPieces("If $A\\mathbf{x} = \\lambda\\mathbf{x}$ then"), [
    { text: "If ", math: false },
    { text: "A\\mathbf{x} = \\lambda\\mathbf{x}", math: true, display: false },
    { text: " then", math: false },
  ]);
  assert.deepEqual(mathPieces("$$\\det(A) = 0$$"), [{ text: "\\det(A) = 0", math: true, display: true }]);
  assert.deepEqual(mathPieces("\\(x\\) and \\[y\\]").filter((p) => p.math).map((p) => p.text), ["x", "y"]);
  assert.deepEqual(mathPieces("It costs $5 and $10."), [{ text: "It costs $5 and $10.", math: false }]);
  assert.deepEqual(mathPieces("Price \\$3, $x$"), [{ text: "Price $3, ", math: false }, { text: "x", math: true, display: false }]);
  assert.deepEqual(mathPieces("an open $x"), [{ text: "an open $x", math: false }]);
  assert.equal(mathAsText("Find $\\lambda$."), "Find \\lambda.");
});
