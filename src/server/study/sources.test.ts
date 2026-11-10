import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir, vaultRoot } from "../core/vault.ts";
import { RECOGNISED } from "./lms.ts";
import { BUDGET, chunks, clean, courses, gather, matchLabel, sample } from "./sources.ts";
import { ALL, fixture, put } from "./testing.ts";
import { Visible, visibleFor } from "./visible.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

function resetCourses() {
  fs.rmSync(path.join(vaultRoot(), "courses"), { recursive: true, force: true });
}

const empty = () => new Visible(vaultRoot(), []);
const err = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return String(e);
  }
  throw new Error("expected an error");
};

describe("sources", () => {
  it("the_courses_a_space_sees_and_their_parts", () => {
    resetCourses();
    put("courses/CSCI-C 241 Fall 2026/files/x.pdf.md", "x");
    put("courses/CSCI-C 241 Fall 2026/readings/r.pdf.md", "x");
    put("courses/CSCI-C 241 Fall 2026/syllabus.md", "x");
    put("courses/CSCI-C 241 Fall 2026/assignments.md", "x");
    fs.mkdirSync(path.join(vaultRoot(), "courses/Bare"), { recursive: true });
    fs.mkdirSync(path.join(vaultRoot(), "courses/Hidden"), { recursive: true });
    const vis = fixture("s", [
      ["CSCI-C 241 Fall 2026", ["syllabus", "files"]],
      ["Bare", ALL],
      ["Hidden", []],
    ]);
    const got = courses(vis);
    expect(got.length).toBe(2);
    expect(got[0]!.name).toBe("Bare");
    expect(got[0]!.syllabus || got[0]!.files).toBe(false);
    expect(got[1]!.folder).toBe("courses/CSCI-C 241 Fall 2026");
    expect(got[1]!.syllabus && got[1]!.files && got[1]!.readings).toBe(true);
    expect(got[1]!.assignments).toBe(false);
    expect(courses(empty())).toEqual([]);
  });

  it("pdf_text_fragments_are_joined", () => {
    const raw =
      "# Text of x.pdf\n\nCopied from [x.pdf](x.pdf) so it can be read here.\n\n## Page 1\n\nThree different members of\n{\n2\nx\n|\nx\n∈\nR\n}\n that are not members.\n(a)\nThe parking lot is open.";
    const c = clean(raw);
    expect(c.includes("Text of") || c.includes("Copied from")).toBe(false);
    expect(c).toContain("Three different members of { 2 x | x ∈ R } that are not members.");
    expect(c).toContain("(a) The parking lot is open.");
    expect(c.startsWith("## Page 1")).toBe(true);
  });

  it("a_course_folder_gives_its_material_cited_as_the_original_files", () => {
    resetCourses();
    const f = "CSCI-C 241 Fall 2026";
    const c = `courses/${f}`;
    put(`${c}/README.md`, "index only");
    put(`${c}/syllabus.md`, "# Syllabus\nGrading policy.");
    put(`${c}/files/HW/Test 1 Review.pdf`, "%PDF");
    put(`${c}/files/HW/Test 1 Review.pdf.md`, "# Text of Test 1 Review.pdf\n\nTranslate into logic.");
    put(`${c}/files/HW/HW 01.pdf`, "%PDF");
    put(`${c}/.hidden.md`, "secret");
    const vis = fixture("s", [[f, ALL]]);
    const dir = spaceDir("s");
    put(".phaethon/state.md", "never", dir);
    const m = gather(dir, vis, [c], null, BUDGET);
    expect(m.course).toBe(f);
    expect(m.labels[0]).toBe(`${c}/files/HW/Test 1 Review.pdf`);
    expect(m.labels).toContain(`${c}/syllabus.md`);
    expect(m.text.includes("index only") || m.text.includes("secret") || m.text.includes("never")).toBe(false);
    expect(m.text).toContain("Translate into logic.");
    expect(gather(dir, vis, ["courses"], null, BUDGET).labels).toEqual(m.labels);
    expect(gather(dir, vis, [`${c}/files/HW/Test 1 Review.pdf`], null, BUDGET).labels).toEqual([`${c}/files/HW/Test 1 Review.pdf`]);
    expect(err(() => gather(dir, vis, [`${c}/files/HW/HW 01.pdf`], null, BUDGET))).toContain("no text copy");
  });

  it("only_the_parts_the_space_may_see_are_material", () => {
    resetCourses();
    const c = "courses/C";
    put(`${c}/syllabus.md`, "Syllabus text.");
    put(`${c}/grades.md`, "Grade 91%.");
    put(`${c}/files/notes.pdf.md`, "Lecture notes text.");
    put(`${c}/README.md`, "# C\n\n**Grades**: 91% so far.\n\n## Coming up\n\nPS 4.\n");
    const vis = fixture("s", [["C", ["syllabus", "overview"]]]);
    const dir = spaceDir("s");
    expect(gather(dir, vis, [c], null, BUDGET).labels).toEqual([`${c}/syllabus.md`]);
    for (const bad of ["courses/C/grades.md", "courses/C/files/notes.pdf.md", "courses/C/files", "courses/D", "courses/C/../C/grades.md"]) {
      expect(() => gather(dir, vis, [bad], null, BUDGET)).toThrow();
    }
    const m = gather(dir, vis, [`${c}/README.md`], null, BUDGET);
    expect(m.text).toContain("PS 4");
    expect(m.text).not.toContain("91%");
    fs.mkdirSync(path.join(vaultRoot(), "spaces/t"), { recursive: true });
    const other = visibleFor("t");
    expect(() => gather(spaceDir("t"), other, [`${c}/syllabus.md`], null, BUDGET)).toThrow();
  });

  it("paths_outside_the_space_are_refused", () => {
    fs.mkdirSync(path.join(vaultRoot(), "spaces/esc"), { recursive: true });
    const dir = spaceDir("esc");
    put("notes.md", "fine", dir);
    const outside = path.join(vaultRoot(), "outside");
    put("secret.md", "secret", outside);
    put("courses/Old/notes.md", "secret", dir);
    const vis = empty();
    for (const bad of ["../x", "/etc/passwd", ".phaethon/progress.json", "nope.md", "courses/Old/notes.md", "Courses/Old"]) {
      expect(() => gather(dir, vis, [bad], null, BUDGET), bad).toThrow();
    }
    fs.symlinkSync(outside, path.join(dir, "link"));
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(dir, "s.md"));
    expect(() => gather(dir, vis, ["link"], null, BUDGET)).toThrow();
    expect(() => gather(dir, vis, ["s.md"], null, BUDGET)).toThrow();
    const m = gather(dir, vis, ["", "."], null, BUDGET);
    expect(m.text).not.toContain("secret");
    expect(m.text).toContain("fine");
  });

  it("big_notes_are_budgeted_and_sampled", () => {
    resetCourses();
    let notes = "";
    for (let i = 0; i < 200; i++) {
      notes += `## Page ${i}\n\n`;
      const topic = i === 150 ? "A bipartite graph splits its vertices in two." : "Sets and functions and logic.";
      for (let k = 0; k < 80; k++) notes += topic + " ";
      notes += "\n\n";
    }
    expect(notes.length).toBeGreaterThan(400_000);
    put("courses/C/files/Notes/Lecture Notes.pdf.md", notes);
    put("courses/C/files/Notes/Lecture Notes.pdf", "%PDF");
    put("courses/C/syllabus.md", "Short syllabus.");
    const vis = fixture("s", [["C", ALL]]);
    const dir = spaceDir("s");
    const m = gather(dir, vis, ["courses/C"], null, BUDGET);
    expect(Buffer.byteLength(m.text)).toBeLessThanOrEqual(BUDGET + 2_000);
    expect(m.text).toContain("Short syllabus.");
    expect(m.text).toContain("[…]");
    const pages = m.text
      .split("## Page ")
      .slice(1)
      .map((s) => Number(s.trim().split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n));
    expect(pages.length).toBeGreaterThanOrEqual(10);
    expect(pages).toContain(0);
    expect(pages.some((p) => p >= 170)).toBe(true);
    const f = gather(dir, vis, ["courses/C"], "bipartite graphs", 10_000);
    expect(f.text).toContain("bipartite graph splits");
    expect(Buffer.byteLength(f.text)).toBeLessThanOrEqual(12_000);
  });

  it("every file skipped for a tiny budget is an error, never empty material", () => {
    resetCourses();
    for (let i = 0; i < 5; i++) put(`courses/C/files/n${i}.md`, "word ".repeat(2_000));
    const vis = fixture("s", [["C", ALL]]);
    expect(err(() => gather(spaceDir("s"), vis, ["courses/C"], null, 1_000))).toContain("nothing to make cards from");
    // A share freed by a skipped file goes to the others.
    const m = gather(spaceDir("s"), vis, ["courses/C"], null, 4_000);
    expect(m.labels.length).toBeGreaterThan(0);
  });

  it("sampling_never_splits_a_character", () => {
    const s = sample("é".repeat(20_000), 5_000, []);
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(5_100);
    expect([...s].every((c) => c === "é" || "[…]\n".includes(c))).toBe(true);
  });

  it("long_page_continuations_keep_their_pdf_page_for_images_and_citations", () => {
    const text = `## Page 2 ${RECOGNISED}\n\n${"Repeated lecture paragraph. ".repeat(450)}\n\n## Page 19 ${RECOGNISED}\n\n${"A later handwritten relation is reflexive. ".repeat(300)}`;
    const parts = chunks(text);
    expect(parts.length).toBeGreaterThan(4);
    for (const part of parts) {
      if (part.includes("Repeated lecture paragraph")) expect(part.startsWith("## Page 2 ")).toBe(true);
      if (part.includes("A later handwritten relation")) expect(part.startsWith("## Page 19 ")).toBe(true);
    }
    const selected = sample(text, 3_000, ["reflexive"]);
    expect(selected).toContain("## Page 19 ");
    expect(selected).toContain("reflexive");
  });

  it("citations_are_matched_to_the_sources", () => {
    const labels = ["courses/C/files/HW/Test 1 Review.pdf", "courses/C/syllabus.md"];
    expect(matchLabel("courses/C/syllabus.md", labels)).toBe(labels[1]);
    expect(matchLabel("Test 1 Review.pdf", labels)).toBe(labels[0]);
    expect(matchLabel("files/HW/Test 1 Review.pdf.md", labels)).toBe(labels[0]);
    expect(matchLabel("lecture.pdf", labels)).toBeNull();
  });

  it("a test file named without a space still counts as exam material", () => {
    resetCourses();
    put("courses/C/files/a notes.md", "Notes body text here.");
    put("courses/C/files/test1.md", "Practice body text here.");
    const vis = fixture("s", [["C", ALL]]);
    expect(gather(spaceDir("s"), vis, ["courses/C"], null, BUDGET).labels[0]).toBe("courses/C/files/test1.md");
  });
});
