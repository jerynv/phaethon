import { describe, expect, test } from "vitest";

import { CHAT_ACTION_IDS, MAX_ACTIONS, SETTINGS_SECTION, actionLabel, fileManagerName, readActions } from "./chat-actions.ts";
import { admit, attachmentKind, attachmentProblem, formatBytes, mediaTypeOf, typeLabel } from "./attachments.ts";
import { diffLines, diffSummary, foldDiff } from "./diff.ts";
import { escapeCurrencyDollars, normalizeMathDelimiters, prepareMath } from "./math.ts";
import { plainText, spokenReply } from "./spoken.ts";
import { planSentence, questionBefore, readBlock, type StudyPlan } from "./study-chat.ts";
import { citationOf, citationsIn, citeName, holdPartialCitation, markCitations } from "./study-cite.ts";
import { spacePathOf } from "../../viewer/kinds.ts";

describe("chat actions", () => {
  test("a block's ids are read in order, unknown ones and repeats dropped, at most three", () => {
    expect(readActions("add-folder\nadd-files\n")).toEqual(["add-folder", "add-files"]);
    expect(readActions('["Add-Folder", "add-folder", "rm -rf", "settings-spaces"]')).toEqual(["add-folder", "settings-spaces"]);
    expect(readActions("add-files, attach-files show-folder new-space")).toEqual(["add-files", "attach-files", "show-folder"]);
    expect(MAX_ACTIONS).toBe(3);
    expect(readActions("open-terminal\nrun:whoami")).toEqual([]);
  });

  test("every id has the app's own words, and the ids match the core's list", () => {
    for (const id of CHAT_ACTION_IDS) expect(actionLabel(id, "Finder")).toBeTruthy();
    expect(actionLabel("show-folder", "File Explorer")).toBe("Show in File Explorer");
    expect(CHAT_ACTION_IDS).toEqual([
      "add-files", "add-folder", "attach-files", "show-folder", "import-courses", "new-space",
      "settings-assistant", "settings-appearance", "settings-accessibility", "settings-spaces", "settings-courses", "settings-about",
    ]);
    expect(SETTINGS_SECTION["settings-accessibility"]).toBe("appearance");
    expect(fileManagerName("MacIntel")).toBe("Finder");
    expect(fileManagerName("Win32")).toBe("File Explorer");
  });
});

describe("study block", () => {
  test("a block is read only once it is whole and the reply has ended", () => {
    const block = '{"kind": "quiz", "count": 10}';
    expect(readBlock('{"kind": "qu', false)).toEqual({ state: "writing" });
    expect(readBlock(block, false)).toEqual({ state: "writing" });
    expect(readBlock(block, true)).toEqual({ state: "ok", block, kind: "quiz" });
    expect((readBlock('{"kind": "flashcards"}', true) as { kind: string }).kind).toBe("deck");
    expect(readBlock('{"kind": "qu', true).state).toBe("invalid");
    expect(readBlock("[1, 2]", true).state).toBe("invalid");
    expect(readBlock('"quiz"', true).state).toBe("invalid");
    expect(readBlock('{"kind": "essay"}', true).state).toBe("invalid");
    expect(readBlock('{"kind": "essay"}', false).state).toBe("invalid");
    expect(readBlock(`{"kind": "quiz", "x": "${"a".repeat(9000)}"}`, true).state).toBe("invalid");
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
    expect(planSentence(p)).toBe("A quiz of 10 questions on eigenvalues (multiple choice, true or false and short answer), exam level, from MATH-M 301.");
    expect(planSentence({ ...p, kind: "deck", count: 1, focus: undefined })).toBe("A deck of 1 card, from MATH-M 301.");
  });

  test("the question is the user message before the reply", () => {
    const msgs = [
      { key: "u1", role: "user", text: "first" },
      { key: "a1", role: "assistant" },
      { key: "u2", role: "user", text: "quiz me" },
      { key: "a2", role: "assistant" },
    ];
    expect(questionBefore(msgs, "a2")).toBe("quiz me");
    expect(questionBefore(msgs, "a1")).toBe("first");
    expect(questionBefore(msgs, "missing")).toBe("quiz me");
  });
});

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
    expect(md.split("\n")[0].includes("$f$")).toBe(false);
    expect(md.includes('[source: x.md "inline code stays code too"]') && md.includes("inside a fence stays code")).toBe(true);
  });

  test("a citation still being written stays text; text without any is unchanged", () => {
    const half = `It covers sets [source: ${C241}/announcements.md "Test 1 will`;
    expect(markCitations(half)).toBe(half);
    expect(markCitations("No sources here.")).toBe("No sources here.");
    expect(citationsIn('[source: a.md "two quotes" "x"]').length).toBe(0);
  });

  test("while streaming, a half-written citation is held back", () => {
    expect(holdPartialCitation('Covered [source: a.md "Test 1 wi')).toBe("Covered");
    expect(holdPartialCitation('Covered [source: a.md "Test 1"] and more')).toBe('Covered [source: a.md "Test 1"] and more');
    expect(holdPartialCitation("No citation")).toBe("No citation");
  });
});

describe("math", () => {
  test("model delimiters become dollars, display math on its own lines", () => {
    expect(normalizeMathDelimiters("so \\(x^2\\) holds")).toBe("so $x^2$ holds");
    expect(prepareMath("Then \\[ \\det(A) = 0 \\] follows")).toBe("Then \n$$\n\\det(A) = 0\n$$\n follows");
    expect(prepareMath("$$a+b$$")).toBe("$$\na+b\n$$");
  });

  test("a dollar amount stays text, math with digits stays math", () => {
    expect(escapeCurrencyDollars("It costs $5 and $10.")).toBe("It costs \\$5 and \\$10.");
    expect(escapeCurrencyDollars("Rent is $1,200.50 a month")).toBe("Rent is \\$1,200.50 a month");
    expect(escapeCurrencyDollars("Solve $2x + 1 = 5$ and $3$")).toBe("Solve $2x + 1 = 5$ and $3$");
    expect(escapeCurrencyDollars("Already \\$5 escaped")).toBe("Already \\$5 escaped");
  });

  test("code is never touched", () => {
    const text = "Use `$5` and\n```\n\\(x\\) $3 \n```\nthen \\(y\\)";
    expect(prepareMath(text)).toBe("Use `$5` and\n```\n\\(x\\) $3 \n```\nthen $y$");
  });

  test("an open display block is held back while streaming, shown as written after", () => {
    expect(prepareMath("Look:\n$$\n\\int_0^1", true)).toBe("Look:");
    expect(prepareMath("Look:\n$$\n\\int_0^1", false)).toBe("Look:\n\\$\\$\n\\int_0^1");
    expect(prepareMath("No math here")).toBe("No math here");
  });
});

describe("diff", () => {
  test("a line diff keeps the common start and end and folds long unchanged runs", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = ["a", "b", "c", "d", "e", "f", "g", "h", "X", "j"].join("\n");
    const d = diffLines(before, after);
    expect(d.filter((l) => l.kind === "removed").map((l) => l.text)).toEqual(["i"]);
    expect(d.filter((l) => l.kind === "added").map((l) => l.text)).toEqual(["X"]);
    expect(diffSummary(d)).toBe("1 line removed, 1 added.");
    const folded = foldDiff(d);
    expect(folded[0]).toEqual({ kind: "fold", count: 5 });
    expect(diffSummary(diffLines("a\n", "a\n"))).toBe("No lines change.");
    expect(diffSummary(diffLines("", "x\ny\n"))).toBe("2 lines added.");
  });
});

describe("attachments", () => {
  test("kinds, limits and words", () => {
    expect(attachmentKind({ name: "a.PNG", type: "" })).toBe("image");
    expect(attachmentKind({ name: "Cargo.toml", type: "" })).toBe("text");
    expect(attachmentKind({ name: "x.zip", type: "application/zip" })).toBeNull();
    expect(mediaTypeOf({ name: "notes.rs", type: "" })).toBe("text/plain");
    expect(mediaTypeOf({ name: "a.jpg", type: "" })).toBe("image/jpeg");
    expect(attachmentProblem({ name: "big.png", type: "image/png", size: 6 * 1024 * 1024 })).toBe("big.png is too large (the limit is 5 MB for images).");
    expect(attachmentProblem({ name: "e.txt", type: "text/plain", size: 0 })).toBe("e.txt is empty.");
    expect(typeLabel("photo.jpeg", "image/jpeg")).toBe("JPG");
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  test("a batch is admitted up to the room left, the rest said in words", () => {
    const f = (name: string, size = 10) => ({ name, type: "", size });
    const out = admit([f("a.txt"), f("b.zip"), f("c.exe"), f("d.md"), f("e.md")], 2);
    expect(out.ok.map((x) => x.name)).toEqual(["a.txt", "d.md"]);
    expect(out.problems[0]).toBe("2 files can’t be attached: b.zip and c.exe. Attach images, PDFs, Word documents, or text or code files.");
    expect(out.problems[1]).toBe("A message can carry up to 10 files, so e.md wasn’t added.");
  });
});

describe("spoken", () => {
  test("markdown is spoken as plain words, and long replies only in part", () => {
    expect(plainText("## Plan\n- **one**\n- `two`\n```js\nx\n```\n[link](a.md)")).toBe("Plan. one two (code) link");
    expect(plainText("Buttons\n```phaethon-actions\nadd-files\n```")).toBe("Buttons");
    const long = "First sentence here. ".repeat(20);
    expect(spokenReply(long).endsWith("The rest is in the conversation.")).toBe(true);
  });
});

describe("links", () => {
  test("a reply's relative link is a space path; web links and climbing out are not", () => {
    expect(spacePathOf("notes/week1.md")).toBe("notes/week1.md");
    expect(spacePathOf("./a/../b.md#x")).toBe("b.md");
    expect(spacePathOf("https://example.com")).toBeNull();
    expect(spacePathOf("#top")).toBeNull();
    expect(spacePathOf("/etc/hosts")).toBeNull();
    expect(spacePathOf("courses/M%20301/README.md")).toBe("courses/M 301/README.md");
  });
});
