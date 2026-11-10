import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { spaceDir, vaultRoot } from "../core/vault.ts";
import { cancel, claimRun, context, make, origin, parse, plan, record, releaseRun, resolveSources, running } from "./chat.ts";
import { deleteItem } from "./store.ts";
import { ALL, Scripted, fixture, put } from "./testing.ts";
import { Visible, visibleFor } from "./visible.ts";

const env = tempHome();
afterAll(() => env.cleanup());

const FOLDER = "courses/MATH-M 301 Fall 2026";
const SRC = `${FOLDER}/files/Eigen notes.pdf`;
const EV = "An eigenvector of A is a nonzero vector v with Av = λv; λ is its eigenvalue.";
const ROOTS = "The eigenvalues are the roots of det(A − λI) = 0.";

let dir = "";
const vis = () => visibleFor("s");

beforeEach(() => {
  fs.rmSync(vaultRoot(), { recursive: true, force: true });
  put(`${FOLDER}/files/Eigen notes.pdf`, "%PDF");
  put(`${FOLDER}/files/Eigen notes.pdf.md`, `# Text of Eigen notes.pdf\n\n${EV}\n${ROOTS}\nA 2×2 matrix with two distinct eigenvalues is diagonalizable.`);
  fixture("s", [["MATH-M 301 Fall 2026", ALL]]);
  dir = spaceDir("s");
});

describe("blocks", () => {
  it("a block is read strictly and bounded", () => {
    const a = parse('{"kind":"quiz","title":"Eigen  practice","focus":"eigenvalues","count":12,"kinds":["choice","True/False","essay"],"difficulty":"hard","sources":["courses/X","courses/X"]}');
    expect([a.kind, a.count, a.difficulty]).toEqual(["quiz", 12, "harder"]);
    expect(a.title).toBe("Eigen practice");
    expect(a.kinds).toEqual(["choice", "truefalse"]);
    expect(a.notes.some((n) => n.includes("essay"))).toBe(true);
    expect(a.sources).toEqual(["courses/X"]);

    const b = parse('{"kind":"quiz","count":500}');
    expect(b.count).toBe(50);
    expect(b.notes[0]).toContain("At most 50");
    expect(b.kinds).toEqual(["choice", "truefalse", "short"]);
    expect(parse('{"kind":"flashcards"}').count).toBe(20);
    expect(parse('{"kind":"deck","count":"7"}').count).toBe(7);
    expect(parse('{"kind":"deck","count":9999}').count).toBe(100);

    for (const bad of [
      "",
      "{",
      "[1]",
      '"quiz"',
      '{"count": 3}',
      '{"kind":"essay"}',
      '{"kind":"quiz","count":0}',
      '{"kind":"quiz","count":2.5}',
      '{"kind":"quiz","count":-1}',
      '{"kind":"quiz","count":true}',
      '{"kind":"quiz","title":7}',
      '{"kind":"quiz","sources":{"a":1}}',
      '{"kind":"quiz","sources":[1,2]}',
    ]) {
      expect(() => parse(bad), bad).toThrow();
    }
    expect(() => parse(`{"kind":"quiz","title":"${"x".repeat(200)}"}`)).toThrow("too long");
    const many = `{"kind":"quiz","sources":[${Array.from({ length: 30 }, (_, i) => `"s${i}"`).join(",")}]}`;
    expect(() => parse(many)).toThrow("too many");
    expect(() => parse("x".repeat(8193))).toThrow();
    // Fixed: a single string source is held to the same length as a list item.
    expect(() => parse(`{"kind":"quiz","sources":"${"y".repeat(501)}"}`)).toThrow("one of its sources is too long");
    expect(parse(`{"kind":"quiz","sources":"${"y".repeat(500)}"}`).sources[0]!.length).toBe(500);
  });

  it("the origin ignores whitespace only", () => {
    const a = origin("Quiz me on eigenvalues", '{"kind": "quiz"}');
    expect(origin("Quiz me on  eigenvalues\n", '{"kind":  "quiz"}\n')).toBe(a);
    expect(origin("Quiz me on matrices", '{"kind": "quiz"}')).not.toBe(a);
    expect(a).toHaveLength(16);
  });

  it("context is the question and the prose", () => {
    const c = context("quiz me", "Here is the plan.\n```phaethon-study\n{}\n```\n")!;
    expect(c).toContain("quiz me");
    expect(c).toContain("Here is the plan.");
    expect(c).not.toContain("```");
    const long = context("q".repeat(10_000), "r")!;
    expect(Buffer.byteLength(long)).toBeLessThan(4_000);
    expect(long).toContain("[…]");
    expect(context(" ", "")).toBeNull();
  });
});

describe("sources", () => {
  it("sources are resolved within what the space sees", () => {
    const v = vis();
    for (const raw of [FOLDER, "MATH-M 301", "M301", `${FOLDER}/`]) {
      const [ok, unknown] = resolveSources(dir, v, [raw]);
      expect([ok.length, unknown.length], raw).toEqual([1, 0]);
      expect(ok[0]!.path, raw).toBe(FOLDER);
    }
    const [ok] = resolveSources(dir, v, [SRC]);
    expect(ok[0]).toEqual({ path: SRC, name: "Eigen notes.pdf (MATH-M 301 Fall 2026)" });
    const abs = path.join(v.dirOf(v.courses[0]!)!, "files/Eigen notes.pdf");
    expect(resolveSources(dir, v, [abs])[0][0]!.path).toBe(SRC);
    const [none, unknown] = resolveSources(dir, v, ["CHEM 101", "../../etc/passwd", "/etc/hosts", "courses/Secret"]);
    expect(unknown).toHaveLength(4);
    expect(none).toEqual([]);
    expect(() => plan(dir, v, '{"kind":"quiz","sources":["CHEM 101"]}', "q")).toThrow("CHEM 101");
    expect(resolveSources(dir, v, [])[0][0]!.path).toBe(FOLDER);
    const empty = new Visible(vaultRoot(), []);
    expect(() => plan(dir, empty, '{"kind":"quiz","sources":["CHEM 101"]}', "q")).toThrow("CHEM 101");
  });
});

const BLOCK = '{"kind":"quiz","title":"Eigen practice","focus":"eigenvalues","count":2,"kinds":["choice","truefalse"],"sources":["M301"]}';

function mapReply(): string {
  return JSON.stringify({
    topics: [
      { id: "t1", title: "Eigenvalues and eigenvectors", terms: ["eigenvalue", "eigenvector"], weight: 3, evidence: [{ source: SRC, quote: EV }] },
      { id: "t2", title: "Diagonalization", terms: ["diagonalizable"], evidence: [{ source: SRC, quote: "A 2×2 matrix with two distinct eigenvalues is diagonalizable." }] },
    ],
    exams: [],
  });
}

function reply(): string {
  return JSON.stringify({
    title: "x",
    questions: [
      {
        topic: "t1",
        kind: "choice",
        prompt: "Which $\\lambda$ are eigenvalues of $A$?",
        choices: ["Roots of $\\det(A-\\lambda I)=0$", "Entries on any row", "Columns of $A$", "Pivots of $A^T$"],
        answer: "Roots of $\\det(A-\\lambda I)=0$",
        explanation: "Av = λv with v ≠ 0 needs A − λI singular.",
        citations: [{ source: SRC, quote: ROOTS }],
      },
      { topic: "t1", kind: "truefalse", prompt: "An eigenvector may be the zero vector.", answer: "false", explanation: "Eigenvectors are nonzero by definition.", citations: [{ source: SRC, quote: EV }] },
    ],
  });
}

const YES2 = '{"verdicts": [{"id": "i1", "verdict": "yes", "answerOk": true}, {"id": "i2", "verdict": "yes", "answerOk": true}]}';

describe("making", () => {
  it("a plan is made once with the conversation and opened again after", async () => {
    const v = vis();
    const question = "Can you quiz me on eigenvalues for M301?";
    const answer = `I'll make 2 questions on eigenvalues from your M301 notes.\n\n\`\`\`phaethon-study\n${BLOCK}\n\`\`\``;
    const p = plan(dir, v, BLOCK, question);
    expect([p.made, p.running, p.sources[0]!.name]).toEqual([undefined, false, "MATH-M 301 Fall 2026"]);
    expect([p.exam, p.scope]).toEqual([undefined, undefined]);
    const withExam = () => plan(dir, v, BLOCK.replace('"count":2', '"count":2,"exam":"Midterm"'), question);
    expect([withExam().exam, withExam().scope?.state]).toEqual(["Midterm", "unmapped"]);
    const m = new Scripted([mapReply(), reply(), YES2]);
    const [made, n, g] = await make(dir, v, p, question, answer, m, () => {}, 1_791_000_000_000);
    expect([made, n]).toEqual(["study/quizzes/Eigen practice.json", 2]);
    expect(g!.coverage.map((c) => c.topic)).toEqual(["Eigenvalues and eigenvectors"]);
    const asked = m.asked[1]!.user;
    expect(asked).toContain("<discussion>");
    expect(asked).toContain("quiz me on eigenvalues");
    expect(asked).toContain("from your M301 notes");
    expect(asked).not.toContain("phaethon-study");
    expect(asked).toContain("Focus on: eigenvalues.");
    expect(asked).toContain("Av = λv");
    expect(withExam().scope?.state).toBe("unknown");
    const again = plan(dir, v, BLOCK, question);
    expect(again.made).toBe(made);
    const none = new Scripted([]);
    // Changed from Rust: the real count, not 0.
    expect(await make(dir, v, again, question, answer, none, () => {}, 1)).toEqual([made, 2, null]);
    expect(none.calls()).toBe(0);
    expect(fs.statSync(path.join(dir, ".phaethon/study/from-chat.json")).isFile()).toBe(true);
    deleteItem(dir, made);
    expect(plan(dir, v, BLOCK, question).made).toBeUndefined();
  });

  it("a damaged from-chat.json is never overwritten", () => {
    const file = path.join(dir, ".phaethon/study/from-chat.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    expect(() => record(dir, "0123456789abcdef", "study/quizzes/X.json", 1)).toThrow(/^It was made, but couldn’t be noted/);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("one run per plan, and it can be stopped", () => {
    const d = "/tmp/phaethon-chat-runs";
    const run = claimRun(d, "abc")!;
    expect(run).not.toBeNull();
    expect(claimRun(d, "abc")).toBeNull();
    expect(running(d, "abc")).toBe(true);
    const other = claimRun(d, "other")!;
    expect(other).not.toBeNull();
    expect(cancel(d, "abc")).toBe(true);
    expect(run.abort.signal.aborted).toBe(true);
    releaseRun(run);
    releaseRun(other);
    expect(running(d, "abc")).toBe(false);
    expect(cancel(d, "abc")).toBe(false);
    const free = claimRun(d, "abc");
    expect(free).not.toBeNull();
    releaseRun(free!);
  });
});
