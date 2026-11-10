import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault, spacesRoot, vaultRoot } from "../core/vault.ts";
import { attachPending, pendingQuestion, recordBlock, type Message } from "../core/thread.ts";
import { toUi } from "../threads/store.ts";
import { updateSpaceMeta } from "../spaces/meta.ts";
import { fits, healInput, schemaProblems } from "./heal.ts";
import { answerResult, cleanAnswer, parseMap, validateCheck, type CheckInput } from "./lesson.ts";
import { effortFor, settingEffort, turnKind } from "./effort.ts";
import { stablePrompt, systemPrompt, volatilePrompt } from "./prompt.ts";
import { compactionStart, estimateTokens, needsCompaction, COMPACT_TYPE } from "./compaction.ts";
import { LESSON_TOOLS, toolDefs, toolNamed } from "./tools/definitions.ts";
import { activityTarget, label, parseCall } from "./tools/calls.ts";
import { excerpt, parseQuery, search } from "./tools/search.ts";
import { lineCount } from "./tools/files.ts";
import { ACTIONS } from "./app-guide.ts";
import type { Provider } from "../providers/types.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

const checkSchema = toolNamed("check")!.input_schema;

describe("argument healing", () => {
  it("parses stringified JSON only where the schema wants something else, and only if it then fits", () => {
    const input = {
      role: '"check"',
      question: "Which is it?",
      options: '[{"value":"a","label":"One"},{"value":"b","label":"Two"}]',
      multiSelect: "false",
      explanation: "Because.",
      correctAnswer: "a",
    };
    const healed = healInput(input, checkSchema) as Record<string, unknown>;
    expect(healed.role).toBe("check");
    expect(healed.options).toEqual([
      { value: "a", label: "One" },
      { value: "b", label: "Two" },
    ]);
    expect(healed.multiSelect).toBe(false);
    expect(healed.correctAnswer).toBe("a");
    expect(fits(healed, checkSchema)).toBe(true);
    // A string field stays a string even when it looks like JSON.
    expect((healInput({ question: "[1,2]" }, checkSchema) as { question: string }).question).toBe("[1,2]");
    // A parse that still doesn't fit is not kept.
    expect((healInput({ role: '"maybe"' }, checkSchema) as { role: string }).role).toBe('"maybe"');
    // The whole input as a string.
    expect(healInput('{"path":"a.md"}', toolNamed("read_file")!.input_schema)).toEqual({ path: "a.md" });
    expect(healInput({ path: "a.pdf", page: "3" }, toolNamed("read_page")!.input_schema)).toEqual({ path: "a.pdf", page: 3 });
  });

  it("says what to fix", () => {
    const problems = schemaProblems({ role: "guess", question: "q", options: "nope", extra: 1 }, checkSchema);
    expect(problems).toContain('unexpected field "extra"; the fields are role, nodeId, question, options, multiSelect, explanation, correctAnswer');
    expect(problems).toContain('"explanation" is required');
    expect(problems.some((p) => p.startsWith('"role" must be one of "predict", "check"'))).toBe(true);
    expect(problems.some((p) => p.startsWith('"options" must be a JSON array with 2 to 6 items (not a string holding one)'))).toBe(true);
  });
});

describe("lesson tools", () => {
  it("parses prerequisite maps with stable ids and refuses cycles and bad ids", () => {
    const m = parseMap("```mermaid\ngraph TD\n  limits[Limits] --> derivative[The derivative]\n  derivative --> chain-rule[\"Chain rule\"]\n  limits --> chain-rule\n%% note\n```");
    expect(m.nodes).toEqual([
      { id: "limits", label: "Limits" },
      { id: "derivative", label: "The derivative" },
      { id: "chain-rule", label: "Chain rule" },
    ]);
    expect(m.edges).toEqual([
      ["limits", "derivative"],
      ["derivative", "chain-rule"],
      ["limits", "chain-rule"],
    ]);
    expect(() => parseMap("graph TD\na --> b\nb --> c\nc --> a")).toThrow(/cycle through a, b, c/);
    expect(() => parseMap("graph TD\na --> a")).toThrow('"a" points to itself');
    expect(() => parseMap("graph TD\nChainRule --> b")).toThrow(/node id "ChainRule" can't be used/);
    expect(() => parseMap("a --> b")).toThrow(/must start with the line "graph TD"/);
  });

  const q = (over: Partial<CheckInput> = {}): CheckInput => ({
    role: "check",
    question: "What is 2+2?",
    options: [
      { value: "a", label: "4" },
      { value: "b", label: "22" },
    ],
    explanation: "Addition, not concatenation.",
    correctAnswer: "a",
    ...over,
  });

  it("validates checks with fix instructions", () => {
    expect(validateCheck(q(), [])).toEqual(["a"]);
    expect(() => validateCheck(q({ correctAnswer: "4" }), [])).toThrow('correctAnswer "4" isn\'t one of the option values (a, b). Use the value of the right option, not its label or position.');
    expect(() => validateCheck(q({ correctAnswer: ["a", "b"] }), [])).toThrow("Set multiSelect to true");
    expect(validateCheck(q({ correctAnswer: ["a", "b"], multiSelect: true }), [])).toEqual(["a", "b"]);
    expect(() => validateCheck(q({ options: [{ value: "a", label: "4" }, { value: "x", label: "I don't know" }] }), [])).toThrow("the app always offers");
    const withPlan: Message[] = [{ role: "assistant", content: [recordBlock({ kind: "lessonPlan", id: "p", goal: "g", map: "", nodes: [{ id: "limits", label: "L" }] })] }];
    expect(() => validateCheck(q({ nodeId: "derivs" }), withPlan)).toThrow('nodeId "derivs" isn\'t in the lesson plan. Copy one of its node ids exactly: limits.');
  });

  it("grades answers and returns only what the student added", () => {
    const call = { type: "tool_use", id: "t1", name: "check", input: q() };
    const a = cleanAnswer({ answers: ["a"], confidence: 81.6, thinking: "added them" }, call);
    expect(JSON.parse(answerResult(call, a).content)).toEqual({ answers: [{ value: "a", label: "4" }], correct: true, confidence: 82, thinking: "added them" });
    const idk = cleanAnswer({ dontKnow: true }, call);
    expect(JSON.parse(answerResult(call, idk).content)).toEqual({ answers: [], correct: false, dontKnow: true });
    expect(() => cleanAnswer({ answers: ["z"] }, call)).toThrow("That answer isn’t one of the choices.");
    expect(() => cleanAnswer({ answers: ["a", "b"] }, call)).toThrow("Choose one answer.");
    const explain = { type: "tool_use", id: "t2", name: "explain_back", input: { question: "Why?", modelAnswer: "Because." } };
    expect(JSON.parse(answerResult(explain, cleanAnswer({ text: "since", confidence: 40 }, explain)).content)).toEqual({ text: "since", confidence: 40 });
  });

  it("shows an unanswered question after a reload, without the answer key", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "quiz me" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "First one." },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } },
          { type: "tool_use", id: "t2", name: "check", input: q() },
          recordBlock({ kind: "check", id: "t2", question: "What is 2+2?" }),
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
    ];
    const pending = pendingQuestion(msgs);
    expect(pending).toEqual({ kind: "check", question: { id: "t2", role: "check", question: "What is 2+2?", options: q().options, multiSelect: false } });
    expect(JSON.stringify(pending)).not.toContain("Addition");
    const ui = toUi(msgs);
    expect(ui[1].pending).toEqual(pending);
    msgs[2].content.push({ type: "tool_result", tool_use_id: "t2", content: "{}" });
    expect(pendingQuestion(msgs)).toBeUndefined();
    expect(attachPending(toUi(msgs), msgs)[1].pending).toBeUndefined();
  });
});

describe("effort", () => {
  it("thinks harder for tutoring and planning", () => {
    const plan: Message[] = [{ role: "assistant", content: [recordBlock({ kind: "lessonPlan", id: "p", goal: "g", map: "", nodes: [] })] }];
    expect(turnKind("normal", plan)).toBe("chat");
    expect(turnKind("quiz", [])).toBe("plan");
    expect(turnKind("quiz", plan)).toBe("tutor");
    expect(effortFor("chat")).toBe("medium");
    expect(effortFor("chat", "low")).toBe("low");
    expect(effortFor("chat", "bogus")).toBe("medium");
    expect(effortFor("tutor", "low")).toBe("high");
    expect(effortFor("plan")).toBe("high");
    expect(settingEffort("max")).toBe("high");
  });
});

describe("system prompt", () => {
  it("keeps the cached part byte-stable and puts the space after it", () => {
    fs.mkdirSync(path.join(spacesRoot(), "lab"), { recursive: true });
    fs.writeFileSync(path.join(vaultRoot(), "MANUAL.md"), "Call me Sam.\n");
    const a = systemPrompt("school", { claude: true, mode: "normal" });
    const b = systemPrompt("work", { claude: true, mode: "quiz" });
    expect(a.stable).toBe(b.stable);
    expect(a.stable).toBe(stablePrompt(true));
    expect(stablePrompt(false)).not.toContain("send_to_user");
    expect(a.stable).toContain("# Explaining something");
    expect(a.stable).toContain("Length follows the material");
    expect(a.stable).not.toContain("keep replies short");
    expect(a.stable).toContain("# How your replies are shown");
    for (const [id] of ACTIONS) expect(a.stable).toContain(`- ${id}: `);
    expect(a.volatile.startsWith('This space is called "school".')).toBe(true);
    expect(a.volatile).toContain("The user's other spaces are: lab, work.");
    expect(a.volatile).toContain("This space has no standing access to other spaces.");
    expect(a.volatile).toContain("# The user's manual\n\nThe user wrote this to tell you how they want you to work.\n\nCall me Sam.");
    expect(a.volatile).not.toContain("# Tutor mode");
    expect(b.volatile).toContain("# Tutor mode: Quiz me\n\nThe user turned this on for this space, so it holds for every message until they turn it off.");
    expect(b.volatile).toContain("# Teaching");
    expect(volatilePrompt("school", "normal")).toBe(a.volatile);
  });

  it("offers send_to_user to Claude and lesson tools in tutor modes, after the base tools", () => {
    expect(toolDefs({ claude: false, lesson: false }).map((t) => t.name)).toEqual(["list_files", "read_file", "read_page", "search_files", "write_file", "request_access", "app_guide", "study_attempt"]);
    expect(toolDefs({ claude: true, lesson: true }).map((t) => t.name).slice(8)).toEqual(["send_to_user", ...LESSON_TOOLS.map((t) => t.name)]);
    const props = Object.keys((toolNamed("check")!.input_schema as { properties: object }).properties);
    expect(props.indexOf("explanation")).toBeLessThan(props.indexOf("correctAnswer"));
  });
});

describe("tool calls", () => {
  it("checks inputs like the old core", () => {
    expect(parseCall("read_file", {})).toEqual({ ok: false, error: '"path" is required and must be a string' });
    expect(parseCall("list_files", { path: 3 })).toEqual({ ok: false, error: '"path" must be a string' });
    expect(parseCall("list_files", { x: 1 })).toEqual({ ok: false, error: 'unexpected field "x"' });
    expect(parseCall("nope", {})).toEqual({ ok: false, error: "there is no tool named nope" });
    expect(parseCall("read_page", { path: "a", page: 0 })).toEqual({ ok: false, error: "page must be a whole number from 1 to 10000" });
    expect(parseCall("write_file", { path: "@work/a", contents: "" })).toEqual({
      ok: false,
      error: 'write_file can only write in this space; "@work/a" is in the work space, and other spaces can never be written',
    });
    const long = parseCall("request_access", { space: "w", path: "p", reason: "é".repeat(600) });
    expect(long.ok && [...String(long.call.input.reason)].length).toBe(500);
  });

  it("labels calls", () => {
    expect(label("school", { name: "list_files", input: { path: "" } })).toBe("Listing the space");
    expect(label("school", { name: "read_file", input: { path: "@work/calendar/oct.md" } })).toBe("Reading work/calendar/oct.md");
    expect(label("school", { name: "read_file", input: { path: "@school/a.md" } })).toBe("Reading file @school/a.md");
    expect(label("school", { name: "search_files", input: { path: "@work/cal/", query: "shift" } })).toBe("Searching work/cal for “shift”");
    expect(label("school", { name: "request_access", input: { space: "@work", path: "calendar/" } })).toBe("Asking for read access to work/calendar");
    expect(activityTarget({ path: "a\u0007b" }, "/x")).toBe("ab");
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("")).toBe(0);
  });
});

describe("search", () => {
  it("ranks literal and multi-word hits and reports budgets", () => {
    const dir = path.join(env.home, "search");
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".phaethon"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".phaethon", "thread.json"), "chain rule secret");
    fs.writeFileSync(path.join(dir, "notes", "calc.md"), "# Chain rule\n\nDifferentiate the outer function.\nThen multiply by the inner derivative.\n\n```\n# not a heading chain\n```\n");
    fs.writeFileSync(path.join(dir, "notes", "bin.dat"), Buffer.from([0, 1, 2]));
    expect(search([{ dir, prefix: "" }], "chain")).toBe("notes/calc.md:1: # Chain rule\nnotes/calc.md:7: # not a heading chain");
    expect(search([{ dir, prefix: "" }], "inner derivative")).toBe("notes/calc.md:4: [Chain rule] Then multiply by the inner derivative. | ``` | # not a heading chain | ```");
    expect(search([{ dir, prefix: "" }], "zebra")).toBe("No lines contain “zebra”.");
    expect(parseQuery("Chain-Rule  outer").terms).toEqual(["chain", "outer", "rule"]);
    expect(() => parseQuery("  ")).toThrow("query must not be empty");
    expect(excerpt("ééé", 5)).toBe("é…");
  });
});

describe("compaction", () => {
  const provider = { id: "anthropic" } as Provider;
  it("triggers past the threshold, never mid tool round, and starts the view at the summary", () => {
    process.env.PHAETHON_COMPACT_AT = "100";
    const long: Message[] = [
      { role: "user", content: [{ type: "text", text: "x".repeat(800) }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    expect(estimateTokens(long)).toBeGreaterThan(100);
    expect(needsCompaction(long, provider)).toBe(true);
    const midRound: Message[] = [...long, { role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] }];
    expect(needsCompaction(midRound, provider)).toBe(false);
    const compacted: Message[] = [...long, { role: "user", content: [{ type: COMPACT_TYPE, summary: "s" }] }, { role: "assistant", content: [{ type: "text", text: "ok" }] }];
    expect(compactionStart(compacted)).toBe(2);
    expect(needsCompaction(compacted, provider)).toBe(false);
    delete process.env.PHAETHON_COMPACT_AT;
  });

  it("tutor mode setting reads back for the prompt", () => {
    updateSpaceMeta("school", { tutorMode: "cram" });
    expect(volatilePrompt("school", "cram")).toContain("Exam cram");
    updateSpaceMeta("school", { tutorMode: undefined });
  });
});

describe("two questions in one reply", () => {
  it("keeps the one the loop accepted open after it refused the other", () => {
    const q = (id: string) => ({ type: "tool_use", id, name: "check", input: { role: "check", question: `Q ${id}`, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], explanation: "e", correctAnswer: "a" } });
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "teach me" }] },
      { role: "assistant", content: [q("first"), q("second")] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "second", content: "Not run: one question at a time.", is_error: true }] },
    ];
    const pending = pendingQuestion(msgs);
    expect(pending?.kind).toBe("check");
    expect(pending && "question" in pending ? pending.question.id : undefined).toBe("first");
  });
});
