import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { citationOf, citationsIn, citeName, markCitations } from "./cite";
import { examDate, examOptions, scopeWords } from "./exam-options";
import { mathAsText, mathPieces, texStrings } from "./math";
import {
  attemptPoints,
  choiceLabel,
  choiceLetter,
  choicesOf,
  draftCount,
  includesAnswer,
  listWords,
  loadDraft,
  nextUnanswered,
  saveDraft,
  tidyScope,
  verdictOf,
} from "./quiz-answers";
import { loadQuizSession, questionHelpContext, saveQuizSession } from "./quiz-session";
import { dueNow, masteryChanges, requeue } from "./review";
import type { ScopeView } from "./types";
import {
  baseName,
  cardCites,
  clozeAnswer,
  clozePieces,
  durationText,
  evidencePage,
  examKey,
  needsModel,
  progressWords,
  reviewMinutes,
  sameCourse,
  sourceWords,
  spokenFront,
} from "./words";

function fakeStorage() {
  const values = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => void values.set(k, v),
      removeItem: (k: string) => void values.delete(k),
    },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

describe("citations", () => {
  const C241 = "courses/CSCI-C 241 Fall 2026 (All Sections)";

  test("a citation becomes a link that carries it, and back", () => {
    const text = `Test 1 stops at HW 6 [source: ${C241}/announcements.md "Test 1 will not cover graphs or combinatorics."].`;
    const md = markCitations(text);
    expect(md).toMatch(/^Test 1 stops at HW 6 \[announcements\.md\]\(#phaethon-cite:[^)\s]+\)\.$/);
    const href = /\((#phaethon-cite:[^)]+)\)/.exec(md)![1];
    expect(citationOf(href)).toEqual({ path: `${C241}/announcements.md`, quote: "Test 1 will not cover graphs or combinatorics." });
    expect(citationOf("#other")).toBeNull();
    expect(citationOf(undefined)).toBeNull();
    expect(citeName(`${C241}/files/Notes/Lecture Notes.pdf`)).toBe("Lecture Notes.pdf");
  });

  test("curly quotes, math and brackets in a quote survive; code is left alone", () => {
    const q = "A function $f$ is *injective* if f(x) = f(y) implies x = y";
    const text = [
      `See [source: ${C241}/files/Notes.pdf “${q}”] and also`,
      "```",
      `[source: ${C241}/files/Notes.pdf "inside a fence stays code"]`,
      "```",
      'and `[source: x.md "inline code stays code too"]` here.',
    ].join("\n");
    expect(citationsIn(text)).toEqual([{ path: `${C241}/files/Notes.pdf`, quote: q }]);
    const md = markCitations(text);
    expect(md.split("\n")[0]).not.toContain("$f$");
    expect(md).toContain('[source: x.md "inline code stays code too"]');
    expect(md).toContain("inside a fence stays code");
  });

  test("a citation still being written stays text; text without any is unchanged", () => {
    const half = `It covers sets [source: ${C241}/announcements.md "Test 1 will`;
    expect(markCitations(half)).toBe(half);
    expect(markCitations("No sources here.")).toBe("No sources here.");
    expect(citationsIn(`[source: a.md "two quotes" "x"]`)).toHaveLength(0);
  });

  test("sources in words and their pages", () => {
    expect(sourceWords({ source: "courses/C241/files/Lecture 4.pdf", at: "§5.3" })).toBe("Lecture 4 §5.3");
    expect(sourceWords({ source: "courses/C241/files/scan.pdf", picture: 3 })).toBe("scan (read from a picture of the page)");
    expect(evidencePage({ at: "p. 12" })).toBe(12);
    expect(evidencePage({ at: "§2" })).toBeUndefined();
    expect(evidencePage({ picture: 4, at: "p. 9" })).toBe(4);
  });
});

describe("math", () => {
  test("inline, display and bracket math; a lone dollar stays text", () => {
    expect(mathPieces("costs $5 and $10")).toEqual([{ text: "costs $5 and $10", math: false }]);
    expect(mathPieces("a $x^2$ b")).toEqual([
      { text: "a ", math: false },
      { text: "x^2", math: true, display: false },
      { text: " b", math: false },
    ]);
    expect(mathPieces("$$ \\sum x $$")).toEqual([{ text: "\\sum x", math: true, display: true }]);
    expect(mathPieces("\\(a\\) and \\[b\\]")).toEqual([
      { text: "a", math: true, display: false },
      { text: " and ", math: false },
      { text: "b", math: true, display: true },
    ]);
    expect(mathPieces("\\$3")).toEqual([{ text: "$3", math: false }]);
    expect(mathAsText("Is $\\lambda$ real?")).toBe("Is \\lambda real?");
  });

  test("a quoted string in a formula is upright text in curly quotes", () => {
    expect(texStrings('F(\\{"cat","ant"\\})')).toBe("F(\\{\\text{“cat”},\\text{“ant”}\\})");
    expect(texStrings('"a_b"')).toBe('"a_b"');
    expect(texStrings("x^2")).toBe("x^2");
  });
});

describe("quiz answers", () => {
  test("a scope says each part once, whether it was written no or not", () => {
    expect(tidyScope("October 15 or 16, 2026; through HW 6; no graphs or combinatorics; not graphs or combinatorics")).toBe(
      "October 15 or 16, 2026; through HW 6; no graphs or combinatorics",
    );
    expect(tidyScope("through HW 6; not graphs")).toBe("through HW 6; not graphs");
    expect(tidyScope("through HW 6; no graphs; not combinatorics")).toBe("through HW 6; no graphs; not combinatorics");
  });

  test("choices are lettered and lists read as words", () => {
    expect([0, 1, 3, 25, 26].map(choiceLetter)).toEqual(["A", "B", "D", "Z", "27"]);
    expect(listWords([4])).toBe("4");
    expect(listWords([4, 8])).toBe("4 and 8");
    expect(listWords([4, 8, 19])).toBe("4, 8 and 19");
  });

  test("the next question without an answer comes after the current one and wraps round", () => {
    const ids = ["q1", "q2", "q3", "q4"];
    expect(nextUnanswered(ids, { q1: "a", q3: "c" }, -1)).toBe(1);
    expect(nextUnanswered(ids, { q1: "a", q3: "c" }, 1)).toBe(3);
    expect(nextUnanswered(ids, { q1: "a", q3: "c" }, 3)).toBe(1);
    expect(nextUnanswered(ids, { q1: "a", q2: [], q3: " ", q4: ["x"] }, 0)).toBe(1);
    expect(nextUnanswered(ids, { q1: "a", q2: "b", q3: "c", q4: ["d"] }, 0)).toBe(-1);
  });

  test("true/false choices: normalized lower case from the core, shown capitalized, compared without case", () => {
    expect(choicesOf({ kind: "truefalse", choices: [] })).toEqual(["true", "false"]);
    expect(choicesOf({ kind: "truefalse", choices: ["true", "false"] })).toEqual(["true", "false"]);
    expect(choicesOf({ kind: "choice", choices: ["a", "b"] })).toEqual(["a", "b"]);
    expect(choiceLabel({ kind: "truefalse" }, "false")).toBe("False");
    expect(choiceLabel({ kind: "choice" }, "false")).toBe("false");
    expect(includesAnswer("True", "true")).toBe(true);
    expect(includesAnswer(true, "true")).toBe(true);
    expect(includesAnswer(["A set ", "b"], "a set")).toBe(true);
    expect(includesAnswer("", "")).toBe(false);
  });

  test("an ungraded answer is neither right nor wrong, and is left out of the points and the total", () => {
    expect(verdictOf({ correct: false, ungraded: true })).toBe("ungraded");
    expect(verdictOf({ correct: true })).toBe("correct");
    expect(verdictOf({ correct: false, partial: 0.5 })).toBe("partial");
    expect(verdictOf({ correct: false, partial: 0 })).toBe("wrong");
    const results = [{ correct: true }, { correct: false, partial: 0.75 }, { correct: false }, { correct: false, ungraded: true }];
    const p = attemptPoints(results);
    expect(p).toEqual({ points: 1.75, total: 3, ungraded: 1 });
    // The core's score over graded results: 1.75 / 3.
    expect(p.points / p.total).toBeCloseTo(0.5833, 3);
  });

  describe("drafts", () => {
    let restore: () => void;
    beforeEach(() => (restore = fakeStorage()));
    afterEach(() => restore());

    test("kept per quiz as made, and only known questions come back", () => {
      saveDraft("school", "study/quizzes/t.json", 1, { q1: "a", q2: ["x"], gone: "z" });
      expect(draftCount("school", "study/quizzes/t.json")).toBe(3);
      expect(loadDraft("school", "study/quizzes/t.json", 1, ["q1", "q2"])).toEqual({ q1: "a", q2: ["x"] });
      expect(loadDraft("school", "study/quizzes/t.json", 2, ["q1"])).toEqual({});
      expect(draftCount("school", "study/quizzes/t.json")).toBe(0);
      saveDraft("school", "study/quizzes/t.json", 1, { q1: " " });
      expect(draftCount("school", "study/quizzes/t.json")).toBe(0);
    });

    test("layout, question and flags survive leaving, without crossing quiz revisions", () => {
      saveQuizSession("school", "study/quizzes/test.json", 42, { layout: "all", flagged: ["q2", "q2", "removed"], at: 99 });
      expect(loadQuizSession("school", "study/quizzes/test.json", 42, ["q1", "q2"])).toEqual({ layout: "all", flagged: ["q2"], at: 1 });
      expect(loadQuizSession("school", "study/quizzes/test.json", 43, ["q1", "q2"])).toEqual({ layout: "single", flagged: [], at: 0 });
      expect(loadQuizSession("work", "study/quizzes/test.json", 42, ["q1", "q2"])).toEqual({ layout: "single", flagged: [], at: 0 });
    });
  });

  test("question help carries the question and the student's answer, never the expected answer", () => {
    const quiz = { title: "Functions", course: "Discrete mathematics", sources: ["courses/Discrete/notes.md"] };
    const question = { kind: "choice", prompt: "Which function is injective?", choices: ["f(x)=x", "f(x)=0"], answer: "secret expected answer", explanation: "secret grading explanation" };
    const context = questionHelpContext(quiz, "study/quizzes/Functions.json", question, "f(x)=0");
    expect(context).toMatch(/Discrete mathematics/);
    expect(context).toMatch(/A\. f\(x\)=x; B\. f\(x\)=0/);
    expect(context).toMatch(/My current answer: f\(x\)=0/);
    expect(context).toMatch(/courses\/Discrete\/notes.md/);
    expect(context).not.toMatch(/secret/);
  });
});

describe("words", () => {
  test("cloze blanks, spoken and revealed, Anki tags and hints read as the answer", () => {
    expect(clozePieces("A {{bijection}} is both")).toEqual([
      { text: "A ", blank: false },
      { text: "bijection", blank: true },
      { text: " is both", blank: false },
    ]);
    expect(spokenFront({ front: "A {{bijection}} is {{c2::both::two words}}" })).toBe("A blank is blank");
    expect(clozeAnswer({ front: "A {{bijection}} is {{c2::both::two words}}" })).toBe("A bijection is both");
    expect(clozeAnswer({ front: "spans {{two\nlines}}" })).toBe("spans two\nlines");
  });

  test("progress in words, never a step code", () => {
    expect(progressWords({ step: "mapping", done: 0, total: 2 }, { quiz: true, course: "C241", exam: "Test 1" })).toBe(
      "Reading C241 to see what it teaches and what Test 1 covers (part 1 of 2). The first time takes a few minutes…",
    );
    expect(progressWords({ step: "reading", done: 0, total: 1 }, { quiz: true, exam: "Test 1" })).toBe("Finding the passages that teach each topic in Test 1…");
    expect(progressWords({ step: "making", done: 0, total: 3 }, { quiz: false })).toBe("Writing the cards from those passages…");
    expect(progressWords({ step: "making", done: 1, total: 3 }, { quiz: true })).toBe("Writing replacements for the questions that didn’t pass…");
    expect(progressWords({ step: "checking", done: 12, total: 10, kept: 9, dropped: 1 }, { quiz: true })).toBe(
      "Checking each question against your notes (10 of 10): 9 kept, 1 dropped so far…",
    );
    expect(progressWords({ step: "saving", done: 0, total: 1 }, { quiz: false })).toBe("Saving the cards…");
    expect(progressWords({ step: "whatever", done: 0, total: 0 }, { quiz: false })).toBe("Getting started…");
  });

  test("names, durations, estimates and model errors", () => {
    expect(baseName("study/decks/Graph theory.md")).toBe("Graph theory");
    expect(durationText(20_000)).toBe("under a minute");
    expect(durationText(5 * 60_000)).toBe("5 minutes");
    expect(durationText(61 * 60_000)).toBe("1 hour 1 minute");
    expect(reviewMinutes(0)).toBe(1);
    expect(reviewMinutes(30)).toBe(10);
    expect(needsModel("No API key is set. Add one in Settings.")).toBe(true);
    expect(needsModel("The file is gone.")).toBe(false);
    expect(cardCites({ source: "courses/a/b.pdf", quote: "q", picture: 2 })).toEqual([{ source: "courses/a/b.pdf", quote: "q", at: "p. 2", picture: 2 }]);
    expect(cardCites({ source: "courses/a/b.pdf" })).toEqual([]);
  });

  test("exam names compare loosely; an exam with no course is any course's", () => {
    expect(examKey("Exam1")).toBe(examKey("Test 1"));
    expect(examKey("Midterm-2")).toBe("midterm 2");
    const course = { name: "Discrete Structures", folder: "courses/CSCI-C 241" };
    expect(sameCourse(undefined, course)).toBe(true);
    expect(sameCourse("CSCI-C241", course)).toBe(true);
    expect(sameCourse("Calculus", course)).toBe(false);
  });
});

describe("exam options", () => {
  const course = { name: "Discrete Structures", folder: "courses/Discrete Structures" };
  const scope = (title: string, known: boolean, date?: string) => ({
    title,
    date,
    known,
    summary: known ? "through HW 6" : "",
    includes: ["t1"],
    excludes: [],
    excludedWords: known ? ["graphs"] : [],
    homework: [],
    evidence: [],
    fromUser: false,
  });

  test("mapped, stated and planned tests, deduplicated by name and sorted by date", () => {
    const view: ScopeView = {
      course: "courses/Discrete Structures",
      name: "Discrete Structures",
      state: "fresh",
      map: { course: "x", name: "x", built: 0, topics: [], notation: [], exams: [scope("Test 1", true, "2026-10-15"), scope("Test 2", false, "2026-11-19")], dropped: 0 },
      stated: [{ exam: "Final", text: "everything", at: 0 }],
    };
    const opts = examOptions(course, view, [
      { id: "a", title: "Exam 1", date: "2026-10-15", course: "Discrete" },
      { id: "b", title: "Quiz 3", date: "2026-11-01" },
      { id: "c", title: "Lab exam", date: "2026-10-20", course: "Calculus" },
    ]);
    expect(opts.map((o) => [o.title, o.state])).toEqual([
      ["Test 1", "known"],
      ["Quiz 3", "unknown"],
      ["Test 2", "unknown"],
      ["Final", "stated"],
    ]);
    expect(scopeWords(opts[0]!.scope!)).toBe("through HW 6; not graphs");
  });

  test("a stale or missing map leaves unknown tests unchecked", () => {
    const stale: ScopeView = { course: "c", name: "c", state: "stale", map: { course: "x", name: "x", built: 0, topics: [], notation: [], exams: [scope("Test 1", false)], dropped: 0 }, stated: [] };
    expect(examOptions(course, stale, []).map((o) => o.state)).toEqual(["unchecked"]);
    expect(examOptions(course, null, [{ id: "x", title: "Midterm", date: "2026-10-01" }]).map((o) => o.state)).toEqual(["unchecked"]);
    expect(examDate("2026-10-15")).toMatch(/15/);
    expect(examDate(undefined)).toBe("");
  });
});

describe("review queue", () => {
  test("a card rated again comes back 3 or 8 cards later, or at the end", () => {
    const q = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    expect(requeue(q, 0, "a", 1)).toEqual(["a", "b", "c", "d", "a", "e", "f", "g", "h", "i", "j", "k", "l"]);
    expect(requeue(q, 0, "a", 2).indexOf("a", 1)).toBe(9);
    expect(requeue(["a", "b"], 0, "a", 1)).toEqual(["a", "b", "a"]);
  });

  test("due now: never studied or its time has come", () => {
    const now = 1_000;
    expect(dueNow([{ id: 1 }, { id: 2, confidence: 3, due: 500 }, { id: 3, confidence: 4, due: 5_000 }], now).map((c) => c.id)).toEqual([1, 2]);
  });

  test("mastery changes in whole percents", () => {
    expect(
      masteryChanges(
        [{ path: "a", title: "A", mastery: 0.5 }, { path: "b", title: "B", mastery: 0.2 }],
        [{ path: "a", title: "A", mastery: 0.504 }, { path: "b", title: "B", mastery: 0.4 }, { path: "c", title: "C", mastery: 1 }],
      ),
    ).toEqual([{ path: "b", title: "B", was: 20, now: 40 }]);
  });
});
