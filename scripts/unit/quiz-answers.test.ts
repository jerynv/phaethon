// node --test scripts/unit/
import assert from "node:assert/strict";
import { test } from "node:test";

import { choiceLetter, listWords, nextUnanswered, tidyScope } from "../../src/lib/quiz-answers.ts";
import { texStrings } from "../../src/lib/study-math.ts";

test("a scope says each part once, whether it was written no or not", () => {
  assert.equal(tidyScope("October 15 or 16, 2026; through HW 6; no graphs or combinatorics; not graphs or combinatorics"), "October 15 or 16, 2026; through HW 6; no graphs or combinatorics");
  assert.equal(tidyScope("through HW 6; not graphs"), "through HW 6; not graphs");
  assert.equal(tidyScope("through HW 6; no graphs; not combinatorics"), "through HW 6; no graphs; not combinatorics");
});

test("choices are lettered and lists read as words", () => {
  assert.deepEqual([0, 1, 3, 25].map(choiceLetter), ["A", "B", "D", "Z"]);
  assert.equal(listWords([4]), "4");
  assert.equal(listWords([4, 8]), "4 and 8");
  assert.equal(listWords([4, 8, 19]), "4, 8 and 19");
});

test("the next question without an answer comes after the current one and wraps round", () => {
  const ids = ["q1", "q2", "q3", "q4"];
  assert.equal(nextUnanswered(ids, { q1: "a", q3: "c" }, -1), 1);
  assert.equal(nextUnanswered(ids, { q1: "a", q3: "c" }, 1), 3);
  assert.equal(nextUnanswered(ids, { q1: "a", q3: "c" }, 3), 1);
  assert.equal(nextUnanswered(ids, { q1: "a", q2: [], q3: " ", q4: ["x"] }, 0), 1, "an empty pick or blank text is no answer");
  assert.equal(nextUnanswered(ids, { q1: "a", q2: "b", q3: "c", q4: ["d"] }, 0), -1);
});

test("a quoted string in a formula is upright text in curly quotes", () => {
  assert.equal(texStrings('F(\\{"cat","ant"\\})'), "F(\\{\\text{“cat”},\\text{“ant”}\\})");
  assert.equal(texStrings('"a_b"'), '"a_b"', "a string text mode can't hold is left as it is");
  assert.equal(texStrings("x^2"), "x^2");
});
