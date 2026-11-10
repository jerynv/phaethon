import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault, vaultRoot } from "../core/vault.ts";
import { Library, askVerdicts, isLogistics, scoped, unknownWords, verdictWhy } from "./grounded.ts";
import { RECOGNISED } from "./lms.ts";
import { build, sectionNumbers } from "./scope.ts";
import { courseFiles, wordsOf, type CourseFile } from "./sources.ts";
import { ALL, Scripted, fixture, put } from "./testing.ts";
import { Visible } from "./visible.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

describe("grounded", () => {
  it("answer_validation_requires_an_explicit_boolean_and_retries_bad_replies", async () => {
    const yes = '{"verdicts":[{"id":"i1","verdict":"yes","answerOk":true}]}';
    const fields: [boolean, unknown][] = [[false, undefined], [true, null], [true, "true"], [true, 1], [true, []], [true, {}]];
    for (const [has, value] of fields) {
      const verdict: Record<string, unknown> = { id: "i1", verdict: "yes" };
      if (has) verdict.answerOk = value;
      const bad = JSON.stringify({ verdicts: [verdict] });
      const model = new Scripted([bad, bad]);
      let error = "";
      try {
        await askVerdicts(model, "check these", []);
      } catch (e) {
        error = String(e);
      }
      expect(error).toContain("answerOk for i1 must be a boolean");
      expect(error).toContain("nothing was saved");
      expect(model.calls()).toBe(2);
      expect(model.asked[1]!.user).toContain("answerOk for i1 must be a boolean");

      const again = new Scripted([bad, yes]);
      const v = await askVerdicts(again, "check these", []);
      expect([1].map((i) => verdictWhy(v.get(`i${i}`)))).toEqual([null]);
      expect(again.calls()).toBe(2);
    }
    const model = new Scripted([yes.replace("true", "false")]);
    const v = await askVerdicts(model, "check these", []);
    expect(verdictWhy(v.get("i1"))).toBe("its answer isn’t right by the notes");
    expect(model.calls()).toBe(1);
    // The rest of the decision table.
    expect(verdictWhy(undefined)).toBe("the check gave no verdict on it");
    expect(verdictWhy(["no", "", true])).toBe("the check found it isn’t taught in the passages it cites");
    expect(verdictWhy(["unsure", "", true])).toBe("the check couldn’t confirm it is taught in your notes");
    expect(verdictWhy(["no", "preimages aren't taught", true])).toBe("not taught in your notes or not in scope: preimages aren't taught");
    expect(verdictWhy(["unsure", "x".repeat(200), false])).toBe(`couldn’t be confirmed: ${"x".repeat(160)}`);
  });

  it("words_the_course_never_uses_are_picked_out", () => {
    const vocab = new Set<string>();
    wordsOf("A function is injective when no two inputs share an output. Functions on sets: the image of a set.", vocab);
    expect(unknownWords("Which statement about the preimage $f^{-1}(B)$ of an injective \\mathbb{R} function is true?", vocab)).toEqual(["preimage"]);
    expect(unknownWords("Functions and images", vocab)).toEqual([]);
  });

  it("sections_are_read_as_ranges", () => {
    expect(sectionNumbers("3.8–3.13")).toEqual(["3.8", "3.9", "3.10", "3.11", "3.12", "3.13"]);
    expect(sectionNumbers("5.4")).toEqual(["5.4"]);
    expect(sectionNumbers("Chapter 2")).toEqual([]);
    expect(isLogistics("courses/C/announcements.md")).toBe(true);
    expect(isLogistics("courses/C/files/Syllabus - C241.pdf")).toBe(true);
    expect(isLogistics("courses/C/files/Notes.pdf")).toBe(false);
  });

  it("a_question_may_quote_a_page_read_from_its_picture_only_once_that_picture_was_shown", () => {
    const label = "courses/C/files/Week 4.pdf";
    const text = `## Page 1\n\nTyped: a set is a collection of distinct objects.\n\n## Page 2 ${RECOGNISED}\n\nA relation R on a set A is reflexive\nif for every a e A, (a,a) e R`;
    const files: CourseFile[] = [{ label, sub: "", text, size: 0, modified: 0 }];
    const lib = new Library("/nonexistent", new Visible("/nonexistent", []), files);
    const q = "A relation R on a set A is reflexive if for every a ∈ A, (a,a) ∈ R";
    expect(() => lib.check(label, q)).toThrow("isn’t in Week 4.pdf");
    lib.shown([[label, 1]]);
    expect(() => lib.check(label, q)).toThrow();
    lib.shown([[label, 2]]);
    const [ev, passage] = lib.check(label, q);
    expect([ev.picture, ev.at]).toEqual([2, "p. 2"]);
    expect(passage).toContain("read from the picture of the page");
    expect(passage).toContain("(a,a) e R");
    const [typed] = lib.check(label, "a set is a collection of distinct objects");
    expect(typed.picture).toBeUndefined();
    expect(() => lib.check(label, "a set is a colection of distinct objects, as typed")).toThrow();
  });

  it("a focus word loses only one trailing s", async () => {
    const root = vaultRoot();
    fs.rmSync(path.join(root, "courses"), { recursive: true, force: true });
    put("courses/C241/files/Notes.pdf.md", "5.3 Properties of Functions\n\nA function f is injective if no two inputs give the same output.\n\nA graph is a set of vertices and a set of edges.");
    const vis = fixture("s", [["C241", ALL]]);
    const seen = vis.courses[0]!;
    const map = `{"topics": [
      {"id": "a", "title": "Injective functions", "evidence": [{"source": "Notes.pdf.md", "quote": "A function f is injective if no two inputs give the same output."}]},
      {"id": "b", "title": "Graphs", "evidence": [{"source": "Notes.pdf.md", "quote": "A graph is a set of vertices and a set of edges."}]}
    ], "exams": []}`;
    await build(vis, seen, [], new Scripted([map]), 1, () => {});
    const files = courseFiles(vis, seen);
    const none = new Scripted([]);
    // "graphs" still finds Graphs.
    const g = await scoped(vis, seen, files, [], null, "graphs", 2, none, () => {}, 2);
    expect(g.plan.map(([t]) => t.title)).toEqual(["Graphs"]);
    // Rust stripped every trailing s ("boss" → "bo", too short, so no narrowing and no note); now it's looked for and said.
    const b = await scoped(vis, seen, files, [], null, "boss", 2, none, () => {}, 2);
    expect(b.notes).toEqual(["I couldn’t find “boss” among the topics C241 teaches, so the questions cover all of them instead."]);
    expect(none.calls()).toBe(0);
  });
});
