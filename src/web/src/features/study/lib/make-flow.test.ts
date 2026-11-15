import { describe, expect, test } from "vitest";
import type { StudyPlan } from "../../chat/lib/study-chat";
import type { ExamOption } from "./exam-options";
import { advice, courseOfPaths, draftFromPlan, emptyDraft, hasSuggestion, matchExam, scopeState, scopeSuggestions, stageOf, stages, toggleSuggestion } from "./make-flow";
import type { ScopeView } from "./types";

const LOGIC = "courses/Logic and Proof";
const BIO = "courses/Cell Biology";

const plan = (over: Partial<StudyPlan> = {}): StudyPlan => ({
  origin: "o1",
  kind: "quiz",
  count: 12,
  kinds: ["choice", "essay", "short"],
  difficulty: "harder",
  sources: [{ path: LOGIC, name: "Logic and Proof" }],
  unknown: [],
  notes: [],
  running: false,
  ...over,
});

const view = (over: Partial<ScopeView> = {}): ScopeView => ({
  course: LOGIC,
  name: "Logic and Proof",
  state: "fresh",
  stated: [],
  map: {
    course: LOGIC,
    name: "Logic and Proof",
    built: 1,
    topics: [
      { id: "t1", title: "Conditionals", terms: [], weight: 2, homework: ["files/HW/Problem set 1.pdf"], evidence: [] },
      { id: "t2", title: "Textbook index", terms: [], weight: 1, homework: [], evidence: [], reference: true },
      { id: "t3", title: "Power sets", terms: [], weight: 2, homework: ["files/HW/Problem set 2.pdf"], evidence: [] },
    ],
    notation: [],
    exams: [],
    dropped: 0,
  },
  ...over,
});

describe("the draft", () => {
  test("a course of source paths, only when they agree", () => {
    expect(courseOfPaths([`${LOGIC}/files/a.pdf`, `${LOGIC}/syllabus.md`], [LOGIC, BIO])).toBe(LOGIC);
    expect(courseOfPaths([`${LOGIC}/a.pdf`, `${BIO}/b.pdf`], [LOGIC, BIO])).toBeNull();
    expect(courseOfPaths(["notes/mine.md"], [LOGIC])).toBeNull();
  });

  test("a chat plan prefills the dialog: course, exam, size, known kinds, origin and what was asked", () => {
    const d = draftFromPlan(plan({ exam: "Test 1", title: "Practice", sources: [{ path: `${LOGIC}/files/Review.pdf`, name: "Review.pdf" }] }), [LOGIC, BIO], "  quiz me for test 1 ");
    expect(d).toMatchObject({ kind: "quiz", course: LOGIC, files: [`${LOGIC}/files/Review.pdf`], target: "exam", exam: "Test 1", count: 12, kinds: ["choice", "short"], difficulty: "harder", title: "Practice" });
    expect(d.chat).toEqual({ origin: "o1", context: "The student asked:\nquiz me for test 1" });
    // Topics without a test; a stated scope comes along; counts are held to the most made at once.
    const t = draftFromPlan(plan({ focus: "induction", count: 400, kinds: [], scope: { exam: "Final", state: "known", words: "all of it", fromUser: true, evidence: [], course: BIO, courseName: "Cell Biology" } }), [LOGIC, BIO], "");
    expect(t).toMatchObject({ target: "topics", focus: "induction", count: 50, course: BIO, covers: "all of it", kinds: emptyDraft("quiz").kinds });
    expect(t.chat?.context).toBe("");
  });
});

describe("the chosen test's scope", () => {
  const known: ExamOption = { title: "Test 1", state: "known", scope: { title: "Test 1", known: true, summary: "through Problem set 2", includes: ["t1", "t3"], excludes: [], excludedWords: [], homework: [], evidence: [], fromUser: false } };
  const said: ExamOption = { title: "Midterm", state: "stated", stated: "chapters 1–3" };
  const unknown: ExamOption = { title: "Final", state: "unknown" };
  const words = (o: ExamOption) => o.scope?.summary ?? "";

  test("names match as the core matches them", () => {
    expect(matchExam([known], "exam 1")?.title).toBe("Test 1");
    expect(matchExam([known], "Quiz 2")).toBeNull();
    expect(matchExam([known], " ")).toBeNull();
  });

  test("known, said, unknown once read, unchecked before", () => {
    const opts = [known, said, unknown];
    const v = view();
    expect(scopeState({ target: "topics", exam: "Test 1" }, opts, v, words)).toEqual({ kind: "none" });
    expect(scopeState({ target: "exam", exam: "Test 1" }, opts, v, words)).toMatchObject({ kind: "known", words: "through Problem set 2" });
    expect(scopeState({ target: "exam", exam: "Midterm" }, opts, v, words)).toMatchObject({ kind: "stated", words: "chapters 1–3" });
    expect(scopeState({ target: "exam", exam: "Final" }, opts, v, words)).toMatchObject({ kind: "unknown" });
    expect(scopeState({ target: "exam", exam: "Quiz 9" }, opts, v, words)).toEqual({ kind: "unknown", option: undefined });
    expect(scopeState({ target: "exam", exam: "Final" }, opts, view({ state: "none", map: undefined }), words)).toMatchObject({ kind: "unchecked" });
    expect(scopeState({ target: "exam", exam: "Final" }, opts, view({ state: "stale" }), words)).toMatchObject({ kind: "unchecked" });
  });

  test("suggestions: taught topics in order, then through each homework", () => {
    expect(scopeSuggestions(view())).toEqual({ topics: ["Conditionals", "Power sets"], through: ["Through Problem set 1", "Through Problem set 2"] });
    expect(scopeSuggestions(null)).toEqual({ topics: [], through: [] });
  });

  test("a tapped suggestion joins or leaves what was typed", () => {
    expect(toggleSuggestion("", "Conditionals")).toBe("Conditionals");
    expect(toggleSuggestion("Conditionals; no proofs", "Power sets")).toBe("Conditionals, no proofs, Power sets");
    expect(toggleSuggestion("Conditionals, power sets", "Power sets")).toBe("Conditionals");
    expect(hasSuggestion("a, Power sets", "power sets")).toBe(true);
  });
});

describe("a run's stages", () => {
  test("core steps map to the four stages", () => {
    expect([undefined, "mapping", "reading", "making", "checking", "saving"].map(stageOf)).toEqual(["read", "read", "map", "write", "check", "saved"]);
  });

  test("each stage is done, active or pending, with the step's detail", () => {
    const at = (p: Parameters<typeof stages>[0]) => stages(p, { quiz: true, course: "Logic and Proof", exam: "Test 1" }).map((s) => `${s.id}:${s.state}`);
    expect(at(null)).toEqual(["read:active", "map:pending", "write:pending", "check:pending"]);
    expect(at({ step: "making", done: 0, total: 3 })).toEqual(["read:done", "map:done", "write:active", "check:pending"]);
    expect(at({ step: "saving", done: 0, total: 1 })).toEqual(["read:done", "map:done", "write:done", "check:done"]);
    const s = stages({ step: "checking", done: 4, total: 9, kept: 3, dropped: 1 }, { quiz: true });
    expect(s[3]).toEqual({ id: "check", label: "Checking each against the source", state: "active", detail: "3 kept · 1 dropped · 4 of 9 checked" });
    expect(s[0]!.label).toBe("Reading your materials");
    expect(stages({ step: "mapping", done: 1, total: 3 }, { quiz: false, course: "Cell Biology" })[0]).toMatchObject({ label: "Reading Cell Biology", detail: "Part 2 of 3. The first time takes a few minutes." });
    expect(stages({ step: "making", done: 1, total: 3 }, { quiz: false })[2]!.detail).toBe("Rewriting the cards that didn’t pass");
  });
});

describe("failures say what to do", () => {
  test("by what went wrong", () => {
    expect(advice("No model is set up: add an API key in Settings, or switch to Claude Code.", true).action).toBe("model");
    expect(advice("I couldn’t find what Test 1 covers in your materials, so I haven’t made anything: I won’t guess.", true).action).toBe("scope");
    expect(advice("Nothing passed the check against your notes, so nothing was saved.", false)).toMatchObject({ action: "focus", title: "Couldn’t make the cards from this" });
    expect(advice("Phaethon’s core stopped answering before it finished.", true).action).toBe("retry");
    expect(advice("Something odd.", true)).toMatchObject({ action: "retry", title: "Couldn’t make the quiz" });
  });
});
