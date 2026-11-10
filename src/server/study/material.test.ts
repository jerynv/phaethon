import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault, vaultRoot } from "../core/vault.ts";
import { RECOGNISED, type Report } from "./lms.ts";
import { examPages, pagesInChunk, pagesOfPassages, pictureQuote, pictures, picturesNote, setPagePictureRenderer, view, type PageRef } from "./material.ts";
import { chunks, type CourseFile } from "./sources.ts";
import { ALL, fixture, put } from "./testing.ts";
import type { ExamScope, ScopeMap, Sight, Topic } from "./types.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

const report = (): Report => ({
  version: 2,
  files: [
    { path: "files/Notes/week1.pdf", pages: 3, typed: 0, handwriting: [1, 2, 3] },
    { path: "files/Notes/week9.pdf", pages: 2, typed: 0, handwriting: [1, 2] },
    { path: "files/slides.pdf", pages: 10, typed: 10, pictures: [[4, 2]] },
    { path: "files/typed.pdf", pages: 5, typed: 5 },
  ],
});

const topic = (id: string, source: string): Topic => ({ id, title: id, terms: [], weight: 1, homework: [], evidence: [{ source, quote: "q" }] });

function freshCourses() {
  fs.rmSync(path.join(vaultRoot(), "courses"), { recursive: true, force: true });
  fs.mkdirSync(path.join(vaultRoot(), "courses/C/files"), { recursive: true });
}

describe("material", () => {
  it("an_exam_leans_on_the_flagged_pages_of_its_own_topics_and_of_what_no_topic_placed", () => {
    const r = report();
    const map: ScopeMap = {
      version: 2,
      course: "C",
      name: "C",
      parts: [],
      fingerprint: "",
      built: 0,
      topics: [topic("t1", "courses/C/files/Notes/week1.pdf"), topic("t2", "courses/C/files/typed.pdf"), topic("t3", "courses/C/files/slides.pdf")],
      notation: [],
      exams: [],
      dropped: 0,
    };
    const exam = (inc: string[]): ExamScope => ({ title: "Test 1", known: true, summary: "", includes: inc, excludes: [], excludedWords: [], homework: [], evidence: [], fromUser: false });
    expect(examPages(r, "C", map, exam(["t1", "t2"]))).toBe(5);
    expect(examPages(r, "C", map, exam(["t3"]))).toBe(3);
    expect(examPages(r, "C", null, null)).toBe(6);
    expect(examPages(r, "C", map, { ...exam([]), known: false })).toBe(6);
  });

  it("the_view_alerts_only_a_model_that_isnt_shown_the_pictures", () => {
    freshCourses();
    const vis = fixture("s", [["C", ALL]]);
    const seen = vis.courses[0]!;
    expect(view(seen, null, [], { sees: "no", model: "m", shown: false })).toBeNull();
    seen.state.material = report();
    const blind: Sight = { sees: "no", model: "gpt-3.5-turbo", shown: false };
    const v = view(seen, null, [], blind)!;
    expect(v.pages).toBe(6);
    expect(v.alert!.text.startsWith("Your model can’t look at pictures, and 6 pages of this course are handwriting or diagrams.")).toBe(true);
    expect(v.lines[0]).toBe("5 pages are handwriting or scans: read with text recognition; may contain mistakes.");
    expect(view(seen, null, [], { sees: "yes", model: "Claude Code", shown: true })!.alert).toBeUndefined();

    const chunk =
      '<source path="courses/C/files/Notes/week1.pdf">\n## Page 1 (recognised…)\n\nsets\n\n## Page 2 (recognised…)\n\nmore\n[… the rest of this file isn’t shown here]\n</source>\n\n<source path="courses/C/files/slides.pdf">\n## Page 1\n\ntext\n</source>\n\n<source path="courses/C/files/typed.pdf">x</source>';
    expect(pagesInChunk(seen, chunk, 6)).toEqual([
      ["courses/C/files/Notes/week1.pdf", 1],
      ["courses/C/files/slides.pdf", 4],
      ["courses/C/files/Notes/week1.pdf", 2],
    ]);
    expect(pagesInChunk(seen, chunk, 1).length).toBe(1);
  });

  it("a_later_handwritten_excerpt_selects_its_own_page_image", () => {
    freshCourses();
    const vis = fixture("s", [["C", ALL]]);
    const seen = vis.courses[0]!;
    seen.state.material = { version: 2, files: [{ path: "files/notes.pdf", pages: 19, typed: 0, handwriting: [2, 19] }] };
    const text = `## Page 2 ${RECOGNISED}\n\n${"Earlier unrelated lecture. ".repeat(400)}\n\n## Page 19 ${RECOGNISED}\n\n${"The later handwritten relation is reflexive. ".repeat(300)}`;
    const label = "courses/C/files/notes.pdf";
    const file: CourseFile = { label, sub: "files/notes.pdf.md", size: text.length, modified: 0, text };
    const excerpt = [...chunks(text)].reverse().find((c) => c.includes("later handwritten"))!;
    const request = `<source path="${label}">\n${excerpt}\n</source>`;
    expect(pagesInChunk(seen, request, 1)).toEqual([[label, 19]]);
    expect(pagesOfPassages(seen, [file], request, 1)).toEqual([[label, 19]]);
  });

  it("a_picture_read_quote_is_found_on_the_page_shown_and_nowhere_else", () => {
    const copy =
      "## Page 1\n\nTyped words here and more.\n\n## Page 2 (recognised from handwriting or a scan; may contain mistakes)\n\nA relation R on a set A is reflexive\nif for every a e A, (a,a) e R";
    const q = "A relation R on a set A is reflexive if for every a ∈ A, (a,a) ∈ R";
    expect(pictureQuote(copy, [2], q)).toBe(2);
    expect(pictureQuote(copy, [1], q)).toBeNull();
    expect(pictureQuote(copy, [], q)).toBeNull();
  });

  it("pictures_of_a_scanned_pdf_and_a_picture_file_are_taken_as_stored", () => {
    freshCourses();
    put("courses/C/files/scan.pdf", "%PDF-1.4 fake");
    put("courses/C/files/board.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const vis = fixture("s", [["C", ALL]]);
    const asked: { file: string; pages: number[] }[] = [];
    setPagePictureRenderer((file, pages) => {
      asked.push({ file, pages });
      return pages.filter((p) => p === 1).map((page) => ({ page, mime: "image/png", data: "AAAA" }));
    });
    try {
      const pages: PageRef[] = [
        ["courses/C/files/scan.pdf", 1],
        ["courses/C/files/board.png", 1],
        ["courses/C/files/scan.pdf", 7],
        ["courses/C/../x.png", 1],
      ];
      const got = pictures(vis, vis.courses[0]!, pages, 6);
      expect(got.map((p) => p.label)).toEqual(["courses/C/files/scan.pdf, page 1", "courses/C/files/board.png"]);
      expect(got[0]!.mime).toBe("image/png");
      expect(got[1]!.mime).toBe("image/png");
      expect(asked[0]!.pages).toEqual([1, 7]);
      expect(pictures(vis, vis.courses[0]!, pages, 1).length).toBe(1);
      expect(picturesNote(got)).toContain("courses/C/files/scan.pdf, page 1; courses/C/files/board.png");
      expect(picturesNote([])).toBe("");
    } finally {
      setPagePictureRenderer(null);
    }
    // Without a renderer a PDF gives no picture; a picture file still does.
    expect(pictures(vis, vis.courses[0]!, [["courses/C/files/scan.pdf", 1], ["courses/C/files/board.png", 1]], 6).map((p) => p.label)).toEqual(["courses/C/files/board.png"]);
  });
});
