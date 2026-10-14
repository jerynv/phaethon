// node --test scripts/unit/
import assert from "node:assert/strict";
import { test } from "node:test";

import { citationOf, citationsIn, citeName, markCitations } from "../../src/lib/study-cite.ts";

const C241 = "courses/CSCI-C 241 Fall 2026 (All Sections)";

test("a citation becomes a link that carries it, and back", () => {
  const text = `Test 1 stops at HW 6 [source: ${C241}/announcements.md "Test 1 will not cover graphs or combinatorics."].`;
  const md = markCitations(text);
  assert.match(md, /^Test 1 stops at HW 6 \[announcements\.md\]\(#phaethon-cite:[^)\s]+\)\.$/);
  const href = /\((#phaethon-cite:[^)]+)\)/.exec(md)![1];
  assert.deepEqual(citationOf(href), { path: `${C241}/announcements.md`, quote: "Test 1 will not cover graphs or combinatorics." });
  assert.equal(citationOf("#other"), null);
  assert.equal(citationOf(undefined), null);
  assert.equal(citeName(`${C241}/files/Notes/Lecture Notes.pdf`), "Lecture Notes.pdf");
});

test("curly quotes, math and brackets in a quote survive; code is left alone", () => {
  const q = "A function $f$ is *injective* if f(x) = f(y) implies x = y";
  const text = [
    `See [source: ${C241}/files/Notes.pdf “${q}”] and also`,
    "```",
    `[source: ${C241}/files/Notes.pdf "inside a fence stays code"]`,
    "```",
    `and \`[source: x.md "inline code stays code too"]\` here.`,
  ].join("\n");
  const found = citationsIn(text);
  assert.deepEqual(found, [{ path: `${C241}/files/Notes.pdf`, quote: q }]);
  const md = markCitations(text);
  assert.ok(!md.split("\n")[0].includes("$f$"), "the quote's math is inside the link's address, not drawn");
  assert.ok(md.includes('[source: x.md "inline code stays code too"]') && md.includes("inside a fence stays code"));
});

test("a citation still being written stays text; text without any is unchanged", () => {
  const half = `It covers sets [source: ${C241}/announcements.md "Test 1 will`;
  assert.equal(markCitations(half), half);
  assert.equal(markCitations("No sources here."), "No sources here.");
  assert.equal(citationsIn(`[source: a.md "two quotes" "x"]`).length, 0, "a malformed one isn't guessed at");
});
