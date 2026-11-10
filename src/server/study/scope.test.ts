import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault, vaultRoot } from "../core/vault.ts";
import { RECOGNISED } from "./lms.ts";
import { setPagePictureRenderer } from "./material.ts";
import {
  FROM_YOU,
  VERSION,
  Docs,
  allocate,
  build,
  cached,
  checkMap,
  examScope,
  findExam,
  inScope,
  mapChunks,
  namedExam,
  partsKey,
  pointsTo,
  promptSection,
  scopeWords,
  state,
  stated,
  unknownExam,
} from "./scope.ts";
import { courseFiles } from "./sources.ts";
import { COURSE_ONLY } from "./store.ts";
import { ALL, Scripted, fixture, put } from "./testing.ts";
import type { ScopeMap, Topic } from "./types.ts";
import type { Visible } from "./visible.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

/** The C241 course of the Rust tests, fresh for each test. */
function course(extra: Record<string, Record<string, unknown>> = {}): Visible {
  const root = vaultRoot();
  fs.rmSync(path.join(root, "courses"), { recursive: true, force: true });
  fs.rmSync(path.join(root, ".phaethon", "scope"), { recursive: true, force: true });
  put(
    "courses/C241/announcements.md",
    "# Announcements\n\n## Test 1 Next Week!\n\nThe test will cover everything up through and including HW 6. Test 1 will **not** cover graphs or combinatorics.\n",
  );
  put("courses/C241/files/Notes.pdf", "%PDF");
  put(
    "courses/C241/files/Notes.pdf.md",
    "# Text of Notes.pdf\n\n5.3 Properties of Functions\n\nA function f is injective if no two inputs give the same output.\n\n6.1 Graphs\n\nA graph is a set of vertices and a set of edges.",
  );
  put("courses/C241/files/HW/HW 06.pdf.md", "Problems\n1.\nDecide whether each function is injective.");
  return fixture("s", [["C241", ALL]], extra);
}

const MAP = `{"topics": [
  {"id": "a", "title": "Injective functions", "sections": "5.3", "terms": ["injective"], "weight": 4, "homework": ["HW 6 #1"], "evidence": [{"source": "courses/C241/files/Notes.pdf", "quote": "A function f is injective if no two inputs give the same output."}]},
  {"id": "b", "title": "Graphs", "sections": "6.1", "terms": ["graph", "vertices"], "weight": 2, "evidence": [{"source": "Notes.pdf", "quote": "A graph is a set of vertices and a set of edges."}]},
  {"id": "c", "title": "Preimages", "evidence": [{"source": "Notes.pdf", "quote": "The preimage of a set B under f is every input that lands in B."}]}
],
"notation": [{"symbol": "f(x)", "meaning": "output", "evidence": {"source": "Notes.pdf", "quote": "no two inputs give the same output"}}],
"exams": [
  {"title": "Test 1", "through": "HW 6", "includes": ["a", "c"], "excludes": ["b"], "excludedWords": ["graphs", "combinatorics"], "homework": ["HW 06.pdf.md"], "summary": "through HW 6; not graphs or combinatorics", "evidence": [{"source": "courses/C241/announcements.md", "quote": "Test 1 will not cover graphs or combinatorics."}, {"source": "announcements.md", "quote": "The test will cover all of chapter 9"}]},
  {"title": "Final", "includes": ["a", "b"], "evidence": [{"source": "announcements.md", "quote": "The final covers everything we did all semester long."}]}
]}`;

describe("scope map", () => {
  beforeEach(() => setPagePictureRenderer(null));

  it("quotes_are_checked_and_unsupported_things_dropped", () => {
    const vis = course();
    const files = courseFiles(vis, vis.courses[0]!);
    expect(files.map((f) => f.label)).toEqual(["courses/C241/announcements.md", "courses/C241/files/HW/HW 06.pdf.md", "courses/C241/files/Notes.pdf"]);
    const docs = new Docs(files);
    const { topics, notation, exams, dropped } = checkMap(JSON.parse(MAP), docs, new Set());
    expect(topics.map((t) => t.title)).toEqual(["Injective functions", "Graphs"]);
    expect(topics[0]!.evidence[0]!.at).toBe("§5.3");
    expect(topics[0]!.evidence[0]!.source).toBe("courses/C241/files/Notes.pdf");
    expect(notation.length).toBe(1);
    expect(dropped).toBe(3);
    const t1 = exams[0]!;
    expect(t1.known).toBe(true);
    expect(t1.includes).toEqual(["t1"]);
    expect(t1.excludes).toEqual(["t2"]);
    expect(t1.evidence.length).toBe(1);
    expect(t1.homework).toEqual(["courses/C241/files/HW/HW 06.pdf.md"]);
    expect(exams[1]!.known).toBe(false);
    expect(exams[1]!.includes).toEqual([]);
    expect(scopeWords(t1)).toBe("Test 1: through HW 6; not graphs or combinatorics");
    expect(scopeWords(exams[1]!)).toBe("Final: I couldn’t find what it covers");
    const said = (summary: string) => ({ ...t1, summary });
    expect(scopeWords(said("October 15 or 16; through HW 6; no graphs or combinatorics"))).toBe("Test 1: October 15 or 16; through HW 6; no graphs or combinatorics");
    expect(scopeWords(said("through HW 6; no graphs"))).toBe("Test 1: through HW 6; no graphs; not combinatorics");
    expect(() => checkMap({ topics: [{ title: "x", evidence: [{ source: "Notes.pdf", quote: "not in the file at all, nowhere" }] }] }, docs, new Set())).toThrow();
  });

  it("an exam never lands on a topic through the id of a dropped one", () => {
    const vis = course();
    const docs = new Docs(courseFiles(vis, vis.courses[0]!));
    const { topics, exams } = checkMap(
      {
        topics: [
          { id: "t2", title: "Dropped", evidence: [{ source: "Notes.pdf", quote: "This sentence is nowhere in the notes at all." }] },
          { id: "x", title: "Injective functions", evidence: [{ source: "Notes.pdf", quote: "A function f is injective if no two inputs give the same output." }] },
          { id: "y", title: "Graphs", evidence: [{ source: "Notes.pdf", quote: "A graph is a set of vertices and a set of edges." }] },
        ],
        exams: [{ title: "Test 1", includes: ["t2"], evidence: [{ source: "announcements.md", quote: "Test 1 will not cover graphs or combinatorics." }] }],
      },
      docs,
      new Set(),
    );
    expect(topics.map((t) => [t.id, t.title])).toEqual([
      ["t1", "Injective functions"],
      ["t2", "Graphs"],
    ]);
    // Rust mapped "t2" onto Graphs (the id it happened to assign); the dropped topic's id now maps to nothing.
    expect(exams[0]!.known).toBe(false);
    expect(exams[0]!.includes).toEqual([]);
  });

  it("readings_count_only_where_the_course_points_to_them", () => {
    const vis = course();
    put("courses/C241/syllabus.md", "# Syllabus\n\nBefore Test 1, read Chapter 5 of the textbook, sections 5.1 to 5.3.");
    put("courses/C241/readings/Book.pdf", "%PDF");
    put(
      "courses/C241/readings/Book.pdf.md",
      "# Text of Book.pdf\n\n5.1 Relations\n\nA relation from A to B is a subset of the product A x B.\n\n7.2 Trees\n\nA tree is a connected graph with no cycles at all.",
    );
    const docs = new Docs(courseFiles(vis, vis.courses[0]!));
    const map = {
      topics: [
        {
          id: "r1",
          title: "Relations",
          sections: "5.1",
          evidence: [{ source: "readings/Book.pdf", quote: "A relation from A to B is a subset of the product A x B." }],
          assignedBy: [{ source: "syllabus.md", quote: "read Chapter 5 of the textbook, sections 5.1 to 5.3." }],
        },
        {
          id: "r2",
          title: "Trees",
          sections: "7.2",
          evidence: [{ source: "readings/Book.pdf", quote: "A tree is a connected graph with no cycles at all." }],
          assignedBy: [
            { source: "syllabus.md", quote: "read Chapter 5 of the textbook, sections 5.1 to 5.3." },
            { source: "readings/Book.pdf", quote: "A tree is a connected graph with no cycles at all." },
          ],
        },
        { id: "r3", title: "Trees again", evidence: [{ source: "readings/Book.pdf", quote: "A tree is a connected graph with no cycles at all." }] },
        { id: "a", title: "Injective functions", sections: "5.3", evidence: [{ source: "Notes.pdf", quote: "A function f is injective if no two inputs give the same output." }] },
      ],
      exams: [{ title: "Test 1", includes: ["r1", "r2", "a"], evidence: [{ source: "announcements.md", quote: "The test will cover everything up through and including HW 6." }] }],
    };
    const { topics, exams } = checkMap(map, docs, new Set());
    const by = (t: string) => topics.find((x) => x.title === t)!;
    expect(by("Relations").reference).toBeFalsy();
    expect(by("Relations").assignedBy![0]!.source).toBe("courses/C241/syllabus.md");
    expect(by("Trees").reference).toBe(true);
    expect(by("Trees").assignedBy ?? []).toEqual([]);
    expect(by("Trees again").reference).toBe(true);
    expect(by("Injective functions").reference).toBeFalsy();
    const built: ScopeMap = { version: VERSION, course: "C241", name: "C241", parts: [], fingerprint: "", built: 0, topics, notation: [], exams, dropped: 0 };
    const titles = (ts: Topic[]) => ts.map((t) => t.title);
    expect(titles(inScope(built, exams[0]!))).toEqual(["Relations", "Injective functions"]);
    expect(titles(inScope(built, null))).toEqual(["Relations", "Injective functions"]);
    expect(pointsTo("Read sections 5.1–5.3", "5.1", [], "x")).toBe(true);
    expect(pointsTo("Homework covers Chapter 7", "7.2–7.4", [], "x")).toBe(true);
    expect(pointsTo("Read sections 5.10 and 15.1", "5.1", [], "x")).toBe(false);
    expect(pointsTo("This week: spanning trees", null, ["spanning tree"], "x")).toBe(true);
    expect(pointsTo("This week: sets", null, [], "Trees")).toBe(false);
  });

  it("a_model_that_sees_is_shown_handwritten_pages_and_its_quotes_from_them_are_checked_roughly", async () => {
    const vis = course({
      C241: { material: { version: 2, files: [{ path: "files/Week 4.pdf", pages: 1, typed: 0, handwriting: [1] }] } },
    });
    put("courses/C241/files/Week 4.pdf", "%PDF-1.4 a scanned page");
    put("courses/C241/files/Week 4.pdf.md", `# Text of Week 4.pdf\n\n## Page 1 ${RECOGNISED}\n\nA relation R on a set A is reflexive\nif for every a e A, (a,a) e R`);
    setPagePictureRenderer((_file, pages) => pages.map((page) => ({ page, mime: "image/png", data: "AAAA" })));
    const reply = `{"topics": [
      {"id": "r", "title": "Reflexive relations", "evidence": [{"source": "Week 4.pdf", "quote": "A relation R on a set A is reflexive if for every a ∈ A, (a,a) ∈ R"}]},
      {"id": "a", "title": "Injective functions", "evidence": [{"source": "Notes.pdf", "quote": "A function f is injective if no two inputs give the same output."}]},
      {"id": "x", "title": "Made up", "evidence": [{"source": "Week 4.pdf", "quote": "A function is surjective when every element of the codomain is hit"}]}
    ], "exams": []}`;
    const seeing = new Scripted([reply]);
    seeing.seeing = true;
    const map = await build(vis, vis.courses[0]!, [], seeing, 1, () => {});
    expect(seeing.asked.map((a) => a.pictures.map((p) => p.label))).toEqual([["courses/C241/files/Week 4.pdf, page 1"]]);
    const { system, user } = seeing.asked[0]!;
    expect(system.startsWith(COURSE_ONLY)).toBe(true);
    expect(user).toContain("<pictures>");
    expect(user).toContain("Week 4.pdf, page 1");
    const r = map.topics.find((t) => t.title === "Reflexive relations")!;
    expect([r.evidence[0]!.picture, r.evidence[0]!.at]).toEqual([1, "p. 1"]);
    expect(map.topics.every((t) => t.title !== "Made up")).toBe(true);
    expect(map.topics.find((t) => t.title === "Injective functions")!.evidence[0]!.picture).toBeUndefined();

    const blind = new Scripted([reply]);
    const map2 = await build(vis, vis.courses[0]!, [], blind, 2, () => {});
    expect(map2.topics.every((t) => t.title !== "Reflexive relations")).toBe(true);
    expect(blind.asked[0]!.user).not.toContain("<pictures>");
  });

  it("built_cached_invalidated_and_stated", async () => {
    const vis = course();
    const seen = vis.courses[0]!;
    expect(cached(vis, seen, null)).toBeNull();
    const m = new Scripted(["no json", MAP]);
    const calls: [number, number][] = [];
    const exams = [
      { course: "C241", title: "Test 1", date: "2026-10-15" },
      { title: "Midterm 2", date: "2026-11-20" },
    ];
    const map = await build(vis, seen, exams, m, 7, (d, t) => calls.push([d, t]));
    expect(m.calls()).toBe(2);
    expect(m.asked[0]!.user).toContain("Test 1 on 2026-10-15");
    expect(calls).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(map.exams.map((e) => [e.title, e.known, e.date ?? null])).toEqual([
      ["Test 1", true, "2026-10-15"],
      ["Final", false, null],
      ["Midterm 2", false, "2026-11-20"],
    ]);
    const kept = cached(vis, seen, null)!;
    expect(kept[1]).toBe(true);
    expect(kept[0]).toEqual(map);
    expect(fs.statSync(path.join(vaultRoot(), ".phaethon/scope/C241.json")).isFile()).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    put("courses/C241/files/Notes.pdf.md", "# Text of Notes.pdf\n\n5.3 Properties of Functions\n\nA function f is injective if no two inputs give the same output. More.");
    expect(cached(vis, seen, null)![1]).toBe(false);
    state(vis, seen, "Midterm 2", "Everything on functions, not graphs", 9);
    const r = new Scripted(['{"includes": ["t1", "t9"], "excludes": ["t2"]}']);
    const e = (await examScope(vis, seen, map, "midterm 2", r))!;
    expect(e.fromUser).toBe(true);
    expect(e.includes).toEqual(["t1"]);
    expect(e.excludes).toEqual(["t2"]);
    expect(e.evidence[0]!.source).toBe(FROM_YOU);
    const none = new Scripted([]);
    const e2 = (await examScope(vis, seen, map, "Midterm 2", none))!;
    expect([e2.includes, none.calls()]).toEqual([["t1"], 0]);
    expect(await examScope(vis, seen, map, "Final", none)).toBeNull();
    const t1 = (await examScope(vis, seen, map, "test 1", none))!;
    expect(t1.fromUser).toBe(false);
    expect(t1.known).toBe(true);
    const p = promptSection(vis)!;
    expect(p).toContain("- Injective functions (5.3)");
    expect(p).toContain("Test 1: through HW 6; not graphs or combinatorics");
    expect(p).toContain('[source: courses/C241/announcements.md "Test 1 will not cover graphs or combinatorics."]');
    expect(p).toContain("Not on Test 1: Graphs.");
    expect(p).toContain("Midterm 2: the student says it covers: Everything on functions");
    expect(p).toContain("Final: what it covers wasn't found");
    expect(p).toContain("changed since this was mapped");
    // Deliberate change: a quick check question in chat is allowed; practice sets still go through the block.
    expect(p).toContain("A quick check question while you explain is fine");
    state(vis, seen, "Midterm 2", "", 10);
    expect(stated(vis, seen)).toEqual([]);
  });

  it("not on an exam leaves out reference-only topics", () => {
    const vis = course();
    const seen = vis.courses[0]!;
    const base = (id: string, title: string, reference = false): Topic => ({ id, title, terms: [], weight: 1, homework: [], evidence: [], ...(reference ? { reference: true } : {}) });
    const map: ScopeMap = {
      version: VERSION,
      course: "C241",
      name: "C241",
      parts: [...ALL],
      fingerprint: "",
      built: 0,
      topics: [base("t1", "Sets"), base("t2", "Graphs"), base("t3", "Trees", true)],
      notation: [],
      exams: [{ title: "Test 1", known: true, summary: "sets", includes: ["t1"], excludes: [], excludedWords: [], homework: [], evidence: [{ source: "courses/C241/announcements.md", quote: "x" }], fromUser: false }],
      dropped: 0,
    };
    put(".phaethon/scope/C241.json", JSON.stringify({ maps: { [partsKey(seen)]: map }, stated: [] }));
    const p = promptSection(vis)!;
    expect(p).toContain("Not on Test 1: Graphs.");
    expect(p).not.toContain("Not on Test 1: Graphs; Trees.");
  });

  it("a damaged store reads as empty but is never overwritten", async () => {
    const vis = course();
    const seen = vis.courses[0]!;
    const file = put(".phaethon/scope/C241.json", "{ not json");
    expect(cached(vis, seen, null)).toBeNull();
    expect(stated(vis, seen)).toEqual([]);
    expect(() => state(vis, seen, "Test 1", "through HW 6", 1)).toThrow(/^The course’s scope file can’t be read/);
    await expect(build(vis, seen, [], new Scripted([MAP]), 1, () => {})).rejects.toMatch(/^The course’s scope file can’t be read/);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("a map built in several calls keeps the order taught and every notation", async () => {
    const vis = course();
    const seen = vis.courses[0]!;
    const filler = (tag: string) => `${tag} line of filler text for the review sheet.\n\n`.repeat(1800);
    put("courses/C241/files/Exam review A.md", `Alpha is the first idea of the course.\n\nThe empty set is written as a slashed zero symbol.\n\n${filler("a")}`);
    put("courses/C241/files/Exam review B.md", `Beta is the second idea of the course.\n\nThe size of a set is written with bars around it.\n\n${filler("b")}`);
    put("courses/C241/files/Exam review C.md", `Gamma is the third idea of the course.\n\nDelta is the fourth idea of the course.\n\n${filler("c")}`);
    const chunks = mapChunks(courseFiles(vis, seen));
    expect(chunks.length).toBe(2);
    const ev = (file: string, quote: string) => [{ source: file, quote }];
    const first = JSON.stringify({
      topics: [
        { id: "a", title: "Alpha", evidence: ev("Exam review A.md", "Alpha is the first idea of the course.") },
        { id: "b", title: "Beta", evidence: ev("Exam review B.md", "Beta is the second idea of the course.") },
        { id: "c", title: "Gamma", evidence: ev("Exam review C.md", "Gamma is the third idea of the course.") },
      ],
      notation: [
        { symbol: "∅", meaning: "the empty set", evidence: ev("Exam review A.md", "The empty set is written as a slashed zero symbol.") },
        { symbol: "|S|", meaning: "the size of S", evidence: ev("Exam review B.md", "The size of a set is written with bars around it.") },
      ],
      exams: [],
    });
    const second = JSON.stringify({
      topics: [
        { id: "t1", title: "Alpha", evidence: ev("Exam review A.md", "Alpha is the first idea of the course.") },
        { id: "t3", title: "Gamma", evidence: ev("Exam review C.md", "Gamma is the third idea of the course.") },
        { id: "new", title: "Delta", evidence: ev("Exam review C.md", "Delta is the fourth idea of the course.") },
      ],
      notation: [{ symbol: "∅", meaning: "the set with no members", evidence: ev("Exam review A.md", "The empty set is written as a slashed zero symbol.") }],
      exams: [],
    });
    const m = new Scripted([first, second]);
    const map = await build(vis, seen, [], m, 3, () => {});
    expect(m.calls()).toBe(2);
    expect(m.asked[1]!.user).toContain("<current_map>");
    // Rust appended the lost Beta at the end and replaced notation wholesale.
    expect(map.topics.map((t) => [t.id, t.title])).toEqual([
      ["t1", "Alpha"],
      ["t2", "Beta"],
      ["t3", "Gamma"],
      ["t4", "Delta"],
    ]);
    expect(map.notation.map((n) => [n.symbol, n.meaning])).toEqual([
      ["∅", "the set with no members"],
      ["|S|", "the size of S"],
    ]);
  });

  it("a_space_seeing_fewer_parts_gets_its_own_map", () => {
    course();
    const vis = fixture("s", [["C241", ["files"]]]);
    const files = courseFiles(vis, vis.courses[0]!);
    expect(files.every((f) => !f.label.endsWith("announcements.md"))).toBe(true);
    expect(partsKey(vis.courses[0]!)).toBe("files");
    expect(mapChunks(files).join("")).not.toContain("Test 1");
  });

  it("questions_are_spread_by_weight_over_every_topic", () => {
    const t = (id: string, w: number): Topic => ({ id, title: id, terms: [], weight: w, homework: [], evidence: [] });
    const ts = [t("a", 5), t("b", 1), t("c", 2), t("d", 2)];
    const a = allocate(ts, 10);
    expect(a.reduce((s, [, n]) => s + n, 0)).toBe(10);
    expect(a.every(([, n]) => n >= 1)).toBe(true);
    expect(a[0]![1] > a[2]![1] && a[2]![1] >= a[1]![1]).toBe(true);
    expect(allocate(ts, 2)).toEqual([
      ["a", 1],
      ["b", 0],
      ["c", 1],
      ["d", 0],
    ]);
    const many = Array.from({ length: 26 }, (_, i) => t(`t${i}`, i === 13 || i === 15 ? 5 : i % 3 === 0 ? 2 : 4));
    const picked = allocate(many, 10)
      .map(([, n], i) => [n, i] as const)
      .filter(([n]) => n === 1)
      .map(([, i]) => i);
    expect(picked.length).toBe(10);
    expect(picked.some((i) => i >= 22) && picked.some((i) => i <= 3)).toBe(true);
    for (let i = 1; i < picked.length; i++) expect(picked[i]! - picked[i - 1]!).toBeLessThanOrEqual(5);
    expect(allocate(many, 26).reduce((s, [, n]) => s + n, 0)).toBe(26);
    expect(allocate(ts, 4).map(([, n]) => n)).toEqual([1, 1, 1, 1]);
  });

  it("exams_are_found_by_name", () => {
    const list = [unknownExam("Test 1"), unknownExam("Test 2"), unknownExam("Final Exam")];
    expect(findExam(list, "test 1")!.title).toBe("Test 1");
    expect(findExam(list, "Exam 1")!.title).toBe("Test 1");
    expect(findExam(list, "the final")!.title).toBe("Final Exam");
    expect(findExam(list, "Test 3")).toBeNull();
    expect(namedExam(list, "practice test for Test 1 please")).toBe("Test 1");
    expect(namedExam(list, "Test 12 stuff")).toBeNull();
    expect(namedExam(list, "sets and logic")).toBeNull();
  });
});
