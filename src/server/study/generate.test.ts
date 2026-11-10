import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { spaceDir, vaultRoot } from "../core/vault.ts";
import { kindOf, validate } from "./deck.ts";
import { makeDeck, makeQuiz, review, submit, type QuizOptions } from "./generate.ts";
import { interleave } from "./grounded.ts";
import { cardFrom, questionFrom, similar, spaceMathBraces } from "./items.ts";
import { NO_MODEL, type Model } from "./model.ts";
import { KINDS } from "./quiz.ts";
import * as scope from "./scope.ts";
import type { Material } from "./sources.ts";
import { deckView, deleteItem, loadAttempt, loadQuiz, overview } from "./store.ts";
import { ALL, Scripted, fixture, put } from "./testing.ts";
import type { Picture, StudyEvent } from "./types.ts";
import { visibleFor } from "./visible.ts";

const env = tempHome();
afterAll(() => env.cleanup());

const SRC = "courses/CSCI-C 241/files/HW/Test 1 Review.pdf";
const Q1 = "A conditional p → q is false only when p is true and q is false.";
const Q2 = "The power set of a set with n members has 2^n members.";
const Q3 = "After Test 1, a graph is a set of vertices joined by edges.";
const QA = "Test 1 covers conditionals and power sets. It will not cover graphs.";

let dir = "";
const vis = () => visibleFor("s");

/** A course with a review sheet (two Test 1 topics and one after it) and an announcement of Test 1's scope. */
beforeEach(() => {
  fs.rmSync(vaultRoot(), { recursive: true, force: true });
  put("courses/CSCI-C 241/files/HW/Test 1 Review.pdf", "%PDF");
  put("courses/CSCI-C 241/files/HW/Test 1 Review.pdf.md", `# Text of Test 1 Review.pdf\n\n${Q1}\n${Q2}\n${Q3}`);
  put("courses/CSCI-C 241/announcements.md", `# Announcements\n\n## Test 1\n\n${QA}\n`);
  fixture("s", [["CSCI-C 241", ALL]]);
  dir = spaceDir("s");
});

/** The scope map the "model" gives for that course: Test 1 is t1 and t2, not t3. */
function mapReply(): string {
  return JSON.stringify({
    topics: [
      { id: "t1", title: "Conditionals", terms: ["conditional"], weight: 3, evidence: [{ source: SRC, quote: Q1 }] },
      { id: "t2", title: "Power sets", terms: ["power set"], weight: 2, evidence: [{ source: "Test 1 Review.pdf", quote: Q2 }] },
      { id: "t3", title: "Graphs", terms: ["graph"], weight: 2, evidence: [{ source: "Test 1 Review.pdf", quote: Q3 }] },
    ],
    exams: [
      {
        title: "Test 1",
        includes: ["t1", "t2"],
        excludes: ["t3"],
        excludedWords: ["graphs"],
        summary: "conditionals and power sets",
        evidence: [{ source: "courses/CSCI-C 241/announcements.md", quote: QA }],
      },
    ],
  });
}

const cite = (q: string) => [{ source: SRC, quote: q }];

/** The checker's answer: one verdict per item, in order. */
function verdicts(v: string[]): string {
  return JSON.stringify({ verdicts: v.map((x, i) => ({ id: `i${i + 1}`, verdict: x, missing: x === "yes" ? "" : "preimages aren't taught", answerOk: true })) });
}

function collector() {
  const events: StudyEvent[] = [];
  return { events, emit: (e: StudyEvent) => void events.push(e) };
}

function steps(events: StudyEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) if (e.type === "progress" && out[out.length - 1] !== e.step) out.push(e.step);
  return out;
}

const noop = () => {};

describe("decks", () => {
  it("a deck is mapped, written, checked and reads back with its passages", async () => {
    const good = `Here are your cards:\n\`\`\`json\n${JSON.stringify({
      title: "Logic basics",
      cards: [
        { topic: "t1", front: "When is p → q false?", back: "Only when p is true and q is false.", citations: cite(Q1) },
        { topic: "t2", front: "A set with n members has {{2^n}} subsets.", back: "", citations: [{ source: "Test 1 Review.pdf", quote: Q2 }] },
      ],
    })}\n\`\`\``;
    const m = new Scripted([mapReply(), "Sorry, no JSON here.", good, verdicts(["yes", "yes"])]);
    const { events, emit } = collector();
    const [p, n, g] = await makeDeck(dir, vis(), ["courses/CSCI-C 241"], { count: 2 }, m, emit, 5);
    expect([p, n]).toEqual(["study/decks/Logic basics.md", 2]);
    expect(m.calls()).toBe(4);
    const a1 = m.asked[1]!.user;
    expect(a1).toContain("Write 3 flashcards");
    expect(a1).toContain("- t1: Conditionals");
    expect(a1).toContain("p → q is false");
    expect(a1).not.toContain("t3: Graphs");
    expect(m.asked[3]!.system).toContain("You check practice questions");
    expect(m.asked[3]!.user).toContain(`«${Q1}»`);
    const v = deckView(dir, p);
    expect(v.course).toBe("CSCI-C 241");
    expect(v.sources).toEqual([SRC]);
    expect(v.cards[0]!.quote).toBe(Q1);
    expect(v.cards[1]!.kind).toBe("cloze");
    expect(steps(events)).toEqual(["mapping", "reading", "making", "checking", "saving"]);
    expect([g.asked, g.kept, g.exam]).toEqual([2, 2, undefined]);
    expect(fs.statSync(path.join(vaultRoot(), ".phaethon/scope/CSCI-C 241.json")).isFile()).toBe(true);

    // Again: the map is reused, the deck's cards are shown, and a repeat is dropped before the check.
    const again = JSON.stringify({
      cards: [
        { topic: "t1", front: "When is p → q false?", back: "x", citations: cite(Q1) },
        { topic: "t1", front: "What makes a conditional false?", back: "A true p and a false q.", citations: cite(Q1) },
      ],
    });
    const m2 = new Scripted([again, verdicts(["yes"])]);
    const [p2, n2] = await makeDeck(dir, vis(), [SRC], { count: 1, title: "More logic" }, m2, emit, 6);
    expect([p2, n2]).toEqual(["study/decks/More logic.md", 1]);
    expect(m2.asked[0]!.user).toContain("Already written (don't repeat these):\n- A set with n members");
    expect(m2.asked[1]!.user).toContain("What makes a conditional false?");
    expect(m2.asked[1]!.user).not.toContain("When is p → q false?");
  });

  it("nothing usable writes nothing", async () => {
    const m = new Scripted([mapReply(), "Sorry, I can't.", "Still no.", "No."]);
    await expect(makeDeck(dir, vis(), ["courses/CSCI-C 241"], {}, m, noop, 1)).rejects.toMatch("nothing was saved");
    expect(m.calls()).toBe(4);
    expect(fs.existsSync(path.join(dir, "study/decks"))).toBe(false);
    const none = Scripted.failing(NO_MODEL);
    await expect(makeDeck(dir, vis(), ["courses/CSCI-C 241"], {}, none, noop, 1)).rejects.toBe(NO_MODEL);
    await expect(makeDeck(dir, vis(), ["../elsewhere"], {}, Scripted.failing(NO_MODEL), noop, 1)).rejects.toBeTruthy();
  });
});

/** Four good questions on Test 1's topics, one on graphs (out of scope), one quoting words the file doesn't have, one on preimages. */
function quizReply(): string {
  return JSON.stringify({
    title: "Test 1 practice",
    questions: [
      {
        topic: "t1",
        kind: "choice",
        prompt: "When is p → q false?",
        choices: ["p true, q false", "p false, q true", "both false", "both true"],
        explanation: "A conditional only fails when a true premise leads to a false conclusion.",
        answer: "p true, q false",
        misconceptions: { "p false, q true": "Reading p → q as if it said q → p.", "p true, q false": "not a wrong choice" },
        citations: cite(Q1),
      },
      { topic: "t2", kind: "truefalse", prompt: "A set with 3 members has 6 subsets.", answer: false, explanation: "It has 2^3 = 8.", citations: cite(Q2) },
      {
        topic: "t2",
        kind: "short",
        prompt: "Why does a set with n members have 2^n subsets?",
        answer: "Each member is either in or out of a subset: two choices, n times.",
        explanation: "Counting in-or-out choices.",
        citations: cite(Q2),
      },
      { topic: "t3", kind: "truefalse", prompt: "Every graph has at least one edge.", answer: "false", explanation: "A graph may have no edges.", citations: cite(Q3) },
      {
        topic: "t1",
        kind: "truefalse",
        prompt: "If q is true then p → q is true.",
        answer: "true",
        explanation: "The only false case has q false.",
        citations: [{ source: SRC, quote: "A conditional is true whenever its conclusion is true." }],
      },
      { topic: "t2", kind: "short", prompt: "What is the preimage of a set under a function?", answer: "Every input mapped into it.", explanation: "By definition of preimage.", citations: cite(Q2) },
      {
        topic: "t2",
        kind: "cloze",
        prompt: "The power set of a set with n members has ___ members.",
        answer: "2^n",
        accept: ["2ⁿ"],
        explanation: "One subset per in-or-out pattern.",
        citations: cite(Q2),
      },
    ],
  });
}

const quizOpts = (count: number, more: Partial<QuizOptions> = {}): QuizOptions => ({ count, kinds: ["choice", "truefalse", "short", "cloze"], difficulty: "exam", exam: "Test 1", ...more });

const oneTf = (topic: string, prompt: string, quoteText = Q1, kind = "truefalse", answer = "true") =>
  JSON.stringify({ questions: [{ topic, kind, prompt, answer, explanation: "Only true p and false q fail.", citations: cite(quoteText) }] });

describe("quizzes", () => {
  it("a quiz for an exam keeps only what is taught and in scope", async () => {
    const { events, emit } = collector();
    const more = oneTf("t1", "If p is false, p → q is true.");
    const m = new Scripted([mapReply(), quizReply(), verdicts(["yes", "yes", "yes", "no", "yes"]), more, verdicts(["yes"])]);
    const [p, n, g] = await makeQuiz(dir, vis(), ["courses/CSCI-C 241"], quizOpts(4), m, emit, 1_791_000_000_000);
    expect([p, n]).toEqual(["study/quizzes/Test 1 practice.json", 4]);
    expect(m.calls()).toBe(5);
    const w1 = m.asked[1]!.user;
    expect(w1).toContain("- t1: Conditionals — 3 questions");
    expect(w1).toContain("- t2: Power sets — 2 questions");
    expect(w1).toContain("<not_in_scope>\nGraphs\ngraphs\n</not_in_scope>");
    const c1 = m.asked[2]!.user;
    expect(c1).toContain("Exam: Test 1: conditionals and power sets; not graphs");
    expect(c1).toContain("Words in it that appear nowhere in the course's materials: preimage");
    expect(c1).not.toContain("Every graph has");
    expect(c1).not.toContain("whenever its conclusion");
    const w2 = m.asked[3]!.user;
    expect(w2).toContain("- t1: Conditionals — 1 questions");
    expect(w2).not.toContain("- t2:");
    expect(w2).toContain("thrown away by the check");

    const [, q] = loadQuiz(dir, p);
    expect(q.questions.every((x) => !x.prompt.includes("preimage") && !x.prompt.includes("graph"))).toBe(true);
    // Changed from Rust: interleaved by topic instead of grouped.
    expect(q.questions.map((x) => x.topic)).toEqual(["Conditionals", "Power sets", "Conditionals", "Power sets"]);
    expect(q.questions[0]!.citations![0]!.quote).toBe(Q1);
    expect(q.questions[0]!.source).toBe(SRC);
    // The misconception of a wrong choice survives; one keyed by the right answer doesn't.
    expect(q.questions[0]!.misconceptions).toEqual({ "p false, q true": "Reading p → q as if it said q → p." });
    expect(q.course).toBe("CSCI-C 241");
    expect(q.grounding).toEqual(g);
    expect([g.exam, g.scope, g.asked, g.kept]).toEqual(["Test 1", "conditionals and power sets; not graphs", 4, 4]);
    expect(g.evidence[0]!.quote).toBe(QA);
    const whys = g.dropped.map((d) => d.why);
    expect(whys.some((w) => w.includes("Graphs, isn’t in scope"))).toBe(true);
    expect(whys.some((w) => w.includes("quote isn’t in Test 1 Review.pdf"))).toBe(true);
    expect(whys.some((w) => w.includes("preimages aren't taught"))).toBe(true);
    expect(g.coverage.map((c) => [c.topic, c.count])).toEqual([
      ["Conditionals", 2],
      ["Power sets", 2],
    ]);
    expect(g.notes ?? []).toEqual([]);
    const checking = events.flatMap((e) => (e.type === "progress" && e.step === "checking" && e.kept !== undefined ? [[e.kept, e.dropped]] : []));
    expect(checking[checking.length - 1]).toEqual([5, 3]);

    // Taken, graded and reviewed (answers follow the interleaved order: q2 is the subsets statement, q3 the p-false one).
    const answers = { q1: "p false, q true", q2: "false", q3: "true", q4: "because each element can be in or out" };
    const grader = new Scripted([JSON.stringify({ grades: [{ id: "q4", score: 0.75, feedback: "Right idea; say it's two choices for each of the n members." }] })]);
    const a = await submit(dir, p, answers, () => grader, emit, 1_791_000_100_000);
    expect(a.results.map((r) => [r.correct, r.partial])).toEqual([
      [false, undefined],
      [true, undefined],
      [true, undefined],
      [false, 0.75],
    ]);
    expect(a.results[0]!.feedback).toContain("Reading p → q as if it said q → p.");
    expect(a.results[3]!.feedback.endsWith("(From Test 1 Review.pdf.)")).toBe(true);
    expect(overview(dir, 1_791_000_200_000).quizzes[0]!.lastScore).toBe(a.score);
    const b = await submit(
      dir,
      p,
      answers,
      () => {
        throw NO_MODEL;
      },
      emit,
      1_791_000_300_000,
    );
    expect(b.results[3]!.ungraded).toBe(true);
    expect(b.results[3]!.feedback).toContain("couldn’t be graded");
    const reviewer = new Scripted(["```markdown\n## Conditionals\nYou mixed up which side must be true.\n```"]);
    expect(await review(dir, a.path, () => reviewer, emit)).toBe("## Conditionals\nYou mixed up which side must be true.");

    // A deck from the mistakes.
    const cards = JSON.stringify({ cards: [{ topic: "t1", front: "If p is false, what is p → q?", back: "True, whatever q is.", citations: cite(Q1) }] });
    const md = new Scripted([cards, verdicts(["yes"])]);
    const [deck] = await makeDeck(dir, vis(), [], { fromAttempt: a.path, count: 1 }, md, emit, 2);
    expect(deck).toBe("study/decks/Mistakes from Test 1 practice.md");
    expect(md.asked[0]!.user).toContain("<mistakes>");
    expect(md.asked[0]!.user).toContain("Their answer: p false, q true");
    // Changed from Rust: the focus line names the missed topics.
    expect(md.asked[0]!.user).toContain("Focus on: Conditionals, Power sets.");
    deleteItem(dir, p);
    expect(() => loadAttempt(dir, a.path)).toThrow();
  });

  it("short after the rounds is delivered short, with why, never padded", async () => {
    const ok = oneTf("t1", "If p is false, p → q is true.");
    const bad = JSON.stringify({
      questions: [{ topic: "t2", kind: "short", prompt: "What is the preimage of a set?", answer: "Inputs mapped into it.", explanation: "Definition.", citations: cite(Q2) }],
    });
    const m = new Scripted([mapReply(), ok, verdicts(["yes"]), bad, verdicts(["no"]), bad.replace("preimage of a set?", "preimage of a subset?"), verdicts(["unsure"])]);
    const [p, n, g] = await makeQuiz(dir, vis(), ["courses/CSCI-C 241"], quizOpts(3), m, noop, 9);
    expect(n).toBe(1);
    expect(m.calls()).toBe(7);
    expect(m.asked[3]!.user.includes("thrown away by the check") || m.asked[3]!.user.includes("Already written")).toBe(true);
    expect(g.notes!.some((x) => x.startsWith("Only 1 of the 3 questions you asked for passed the check"))).toBe(true);
    expect(g.coverage.map((c) => [c.count, c.why !== undefined])).toEqual([
      [1, false],
      [0, true],
    ]);
    expect(g.coverage[1]!.why).toBe("its questions didn’t pass the check");
    expect(loadQuiz(dir, p)[1].questions.length).toBe(1);
    const all = new Scripted([bad, verdicts(["no"]), bad, verdicts(["no"]), bad, verdicts(["no"])]);
    await expect(makeQuiz(dir, vis(), ["courses/CSCI-C 241"], quizOpts(2), all, noop, 10)).rejects.toMatch(/^Nothing passed the check against your notes, so nothing was saved/);
  });

  it("a later round's check failing keeps what already passed", async () => {
    const ok = oneTf("t1", "If p is false, p → q is true.");
    const more = oneTf("t1", "If both p and q are true, p → q is true.");
    const m = new Scripted([mapReply(), ok, verdicts(["yes"]), more, "not JSON", "still not JSON"]);
    const [p, n, g] = await makeQuiz(dir, vis(), ["courses/CSCI-C 241"], quizOpts(3), m, noop, 11);
    expect(n).toBe(1);
    expect(m.calls()).toBe(6);
    expect(loadQuiz(dir, p)[1].questions[0]!.prompt).toBe("If p is false, p → q is true.");
    expect(g.dropped.some((d) => d.why.startsWith("checking more stopped: The questions couldn’t be checked against your notes"))).toBe(true);
  });

  it("a malformed item's reason loses its question-number prefix", async () => {
    const reply = JSON.stringify({
      questions: [
        { topic: "t1", kind: "truefalse", prompt: "If p is false, p → q is true.", answer: "true", explanation: "x", citations: cite(Q1) },
        { topic: "t1", kind: "choice", prompt: "Pick the false case", choices: ["a", "b", "c"], answer: "nope", explanation: "x", citations: cite(Q1) },
        { topic: "t1", kind: "short", prompt: "Why?", answer: "because", citations: cite(Q1) },
      ],
    });
    const m = new Scripted([mapReply(), reply, verdicts(["yes"])]);
    const [, , g] = await makeQuiz(dir, vis(), ["courses/CSCI-C 241"], quizOpts(1), m, noop, 12);
    const whys = g.dropped.map((d) => d.why);
    expect(whys).toContain('the answer "nope" isn\'t one of its choices.');
    expect(whys).toContain("has no explanation");
    expect(whys.some((w) => w.startsWith("question"))).toBe(false);
  });

  it("an exam whose scope is unknown stops and asks", async () => {
    const { events, emit } = collector();
    const m = new Scripted([mapReply()]);
    const err = await makeQuiz(dir, vis(), ["courses/CSCI-C 241"], quizOpts(5, { exam: "Final" }), m, emit, 1).catch((e) => e as string);
    expect(err).toContain("I couldn’t find what Final covers");
    expect(err).toContain("I won’t guess");
    expect(m.calls()).toBe(1);
    const asked = events.find((e) => e.type === "needsScope");
    expect(asked).toMatchObject({ type: "needsScope", course: "courses/CSCI-C 241", exam: "Final", courseName: "CSCI-C 241" });
    const v = vis();
    scope.state(v, v.courses[0]!, "Final", "Only conditionals", 2);
    const q = oneTf("t1", "If p is false, p → q is true.");
    const m2 = new Scripted([JSON.stringify({ includes: ["t1"], excludes: [] }), q, verdicts(["yes"])]);
    const [, n, g] = await makeQuiz(dir, v, ["courses/CSCI-C 241"], quizOpts(1, { exam: "final" }), m2, emit, 3);
    expect(n).toBe(1);
    expect(g.fromUser).toBe(true);
    expect(g.evidence[0]!.source).toBe("from you");
    expect(g.scope).toBe("Only conditionals");
    expect(m2.asked[1]!.user).toContain("<not_in_scope>\nPower sets\nGraphs");
  });

  it("the discussion and focus ride along inside the scope", async () => {
    const m = new Scripted([mapReply(), quizReply(), verdicts(["yes", "yes", "yes", "no", "yes"])]);
    const opts = quizOpts(2, {
      focus: "conditionals",
      context: "The student asked:\nquiz me on conditionals\n\nTheir assistant answered, promising this:\n4 questions on p → q",
      exam: null,
    });
    const [, , g] = await makeQuiz(dir, vis(), ["courses/CSCI-C 241"], opts, m, noop, 1);
    const asked = m.asked[1]!.user;
    expect(asked.indexOf("<material>")).toBeLessThan(asked.indexOf("<discussion>"));
    expect(asked).toContain("4 questions on p → q");
    expect(asked).toContain("not course material");
    expect(asked).toContain("- t1: Conditionals");
    expect(asked).not.toContain("- t2:");
    expect(g.coverage.length).toBe(1);
    const m2 = new Scripted([quizReply(), verdicts(["yes", "yes", "yes", "no", "yes"])]);
    const [, , g2] = await makeQuiz(dir, vis(), ["courses/CSCI-C 241"], quizOpts(4, { focus: "eigenvalues" }), m2, noop, 2);
    expect(g2.notes!.some((x) => x.includes("I couldn’t find “eigenvalues” among the topics"))).toBe(true);
    expect(m2.asked[0]!.user).not.toContain("<discussion>");
  });
});

/** A checker that keeps the rule literally: every symbol must be in a cited passage or in <course_notation>, and no unknown words. */
class RuleChecker implements Model {
  readonly asked: { system: string; user: string }[] = [];
  constructor(private readonly writes: string[]) {}
  showsPictures(): boolean {
    return false;
  }
  async completeSeeing(system: string, user: string, _p: Picture[]): Promise<string> {
    return this.complete(system, user);
  }
  async complete(system: string, user: string): Promise<string> {
    this.asked.push({ system, user });
    if (!system.includes("You check practice questions")) return this.writes.shift() ?? "nothing more";
    const notation = user.split("<course_notation>")[1]?.split("</course_notation>")[0] ?? "";
    const out: string[] = [];
    for (const chunk of user.split('<item id="').slice(1)) {
      const id = chunk.slice(0, chunk.indexOf('">'));
      const body = chunk.slice(chunk.indexOf('">') + 2);
      const [asked, rest] = [body.slice(0, body.indexOf("\n<cited>\n")), body.slice(body.indexOf("\n<cited>\n") + 9)];
      const cited = rest.slice(0, rest.indexOf("</cited>"));
      const after = rest.slice(rest.indexOf("</cited>"));
      const symbol = (c: string) => !/[\p{Alphabetic}\p{N}\s]/u.test(c) && !".,;:?!'\"()=-+^_".includes(c);
      const missing = [...asked].filter((c) => symbol(c) && !cited.includes(c) && !notation.includes(c));
      const unknown = after.includes("appear nowhere in the course");
      const verdict = !missing.length && !unknown ? "yes" : "no";
      const why = missing.length ? `${missing[0]} isn't taught` : unknown ? "preimages aren't taught" : "";
      out.push(JSON.stringify({ id, verdict, missing: why, answerOk: true }));
    }
    return `{"verdicts": [${out.join(",")}]}`;
  }
}

describe("notation", () => {
  it("the checker takes the course's evidenced notation as taught and nothing else", async () => {
    const Q4 = "The empty set ∅ is the set with no members, and it is a subset of every set.";
    const NOTES = "courses/CSCI-C 241/files/Notation.md";
    put(NOTES, `# Notation\n\n${Q4}\n`);
    const map = JSON.parse(mapReply());
    map.notation = [{ symbol: "∅", meaning: "the empty set", evidence: { source: "Notation.md", quote: Q4 } }];
    const v = vis();
    const built = await scope.build(v, v.courses[0]!, [], new Scripted([JSON.stringify(map)]), 1, noop);
    expect(built.notation.map((x) => x.symbol)).toEqual(["∅"]);
    const store = path.join(vaultRoot(), ".phaethon/scope/CSCI-C 241.json");
    const kept = JSON.parse(fs.readFileSync(store, "utf8"));
    const entry = Object.values(kept.maps)[0] as { notation: unknown[] };
    entry.notation.push({ symbol: "|S|", meaning: "how many members S has", evidence: [{ source: SRC, quote: "The size |S| of a set S is how many members it has." }] });
    entry.notation.push({ symbol: "⊆", meaning: "is a subset of", evidence: [] });
    fs.writeFileSync(store, JSON.stringify(kept));

    const tf = (prompt: string, answer: string, explanation: string) => ({ topic: "t2", kind: "truefalse", prompt, answer, explanation, citations: cite(Q2) });
    const reply = JSON.stringify({
      title: "Power sets",
      questions: [
        tf("The power set of every set has ∅ as a member.", "true", "∅ is a subset of every set, so it is in the power set."),
        tf("If |S| = 3, the power set of S has 8 members.", "true", "It has 2^3 = 8 members."),
        tf("If A ⊆ B, the power set of A has fewer members.", "false", "Not if A = B."),
        tf("The preimage of a set is its power set.", "false", "By definition of preimage."),
      ],
    });
    const m = new RuleChecker([reply]);
    const [p, n, g] = await makeQuiz(dir, v, ["courses/CSCI-C 241"], quizOpts(4), m, noop, 4);
    expect(n).toBe(1);
    expect(loadQuiz(dir, p)[1].questions[0]!.prompt).toBe("The power set of every set has ∅ as a member.");
    const whys = g.dropped.map((d) => [d.text, d.why]);
    expect(whys).toContainEqual(["If |S| = 3, the power set of S has 8 members.", "not taught in your notes or not in scope: | isn't taught"]);
    expect(whys).toContainEqual(["If A ⊆ B, the power set of A has fewer members.", "not taught in your notes or not in scope: ⊆ isn't taught"]);
    expect(whys.some(([t, w]) => t!.includes("preimage") && w!.includes("preimages aren't taught"))).toBe(true);
    const check = m.asked.find((x) => x.system.includes("You check practice questions"))!;
    expect(check.system).toContain("a symbol listed in <course_notation> counts as taught");
    expect(check.system).toContain("doesn't make any other symbol, term or idea taught");
    const given = check.user.split("<course_notation>")[1]!.split("</course_notation>")[0]!;
    expect(given.trim()).toBe(`∅: the empty set [source: ${NOTES} "${Q4}"]`);
    expect(check.user).toContain("Words in it that appear nowhere in the course's materials: preimage");
    const first = check.user.split("<item id=")[1]!;
    expect(first).toContain("has ∅ as a member");
    expect(first.split("<cited>")[1]!).not.toContain("∅");
    const write = m.asked[0]!.user;
    expect(write).toContain("<notation>\n∅: the empty set");
    expect(write).not.toContain("|S|");
    expect(write).not.toContain("⊆:");
  });
});

const material: Material = { text: "", labels: [SRC], course: null };
const kinds = [...KINDS];
const one = (q: Record<string, unknown>) => questionFrom(q, 1, material, kinds, SRC);

describe("items", () => {
  it("answer keys and fairness are checked", () => {
    const ok = one({
      kind: "choice",
      prompt: "What is $\\det\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}$?",
      choices: ["$-2$", "$2$", "$10$", "$-10$"],
      answer: "$-2$",
      explanation: "1·4 − 2·3 = −2.",
    });
    expect(ok.prompt).toContain("\\begin{bmatrix}");
    expect(ok.choices).toContain("$-2$");
    const bad = (body: Record<string, unknown>) => ({ ...body, explanation: "why" });
    const cases: [Record<string, unknown>, string][] = [
      [bad({ kind: "choice", prompt: "Pick", choices: ["a", "b", "c", "d"], answer: "e" }), "isn't one of its choices"],
      [bad({ kind: "choice", prompt: "Pick", choices: ["a", "A", "c", "d"], answer: "a" }), "two choices are the same"],
      [bad({ kind: "choice", prompt: "Pick", choices: ["a", "b"], answer: "a" }), "at least 3 choices"],
      [bad({ kind: "choice", prompt: "Pick", choices: ["a", "b", "All of the above"], answer: "a" }), "all/none of the above"],
      [bad({ kind: "multi", prompt: "Pick all", choices: ["a", "b", "c"], answer: ["a", "b", "c"] }), "every choice right"],
      [bad({ kind: "multi", prompt: "Pick all", choices: ["a", "b", "c", "d"], answer: ["a", "a"] }), "same right answer twice"],
      [bad({ kind: "cloze", prompt: "A ___ has ___ edges.", answer: "tree" }), "exactly one blank"],
      [bad({ kind: "cloze", prompt: "The eigenvalue ___ is an eigenvalue.", answer: "eigenvalue" }), "gives its answer away"],
      [bad({ kind: "short", prompt: "What does Test 1 Review cover?", answer: "logic" }), "asks about the file"],
      [bad({ kind: "short", prompt: "When is the due date for HW 3?", answer: "Friday" }), "logistics"],
      [bad({ kind: "truefalse", prompt: "The notes.pdf says sets are lists.", answer: "false" }), "names a file"],
      [{ kind: "short", prompt: "Why?", answer: "because" }, "no explanation"],
    ];
    for (const [q, want] of cases) expect(() => one(q), JSON.stringify(q)).toThrow(want);
    // The same question twice is caught by `similar` (dropped before the check, not refused).
    expect(similar("Every square matrix with a zero row is singular.", "Every square matrix with a zero row is singular!")).toBe(true);
  });

  it("math braces never make a blank", () => {
    expect(spaceMathBraces("$\\frac{1}{x^{2}}$ and {{term}}")).toBe("$\\frac{1}{x^{2} }$ and {{term}}");
    expect(spaceMathBraces("costs \\$5 {{x}}")).toBe("costs \\$5 {{x}}");
    const note = cardFrom({ front: "What is $\\frac{1}{x^{2}}$ integrated?", back: "$-\\frac{1}{x} + C$" }, 1, material, SRC);
    expect(kindOf(note)).toBe("basic");
    validate({ title: "M", sources: [], extra: [], preamble: "", notes: [note] });
  });

  it("similar fronts", () => {
    expect(similar("What is a set?", "what is a SET")).toBe(true);
    expect(similar("When is the conditional p → q false?", "When is the conditional p → q ever false?")).toBe(true);
    expect(similar("What is a set?", "What is a graph?")).toBe(false);
  });

  it("interleaves topics round by round", () => {
    expect(interleave(["a1", "a2", "a3", "b1", "c1", "c2"], (x) => x[0]!)).toEqual(["a1", "b1", "c1", "a2", "c2", "a3"]);
  });
});
