import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assessCourse, assessPdf, assessPicture, documents, flaggedPages, MATERIAL_VERSION, normalizeReport, picturePages, summarise, type Report } from "./material.ts";
import { CANT_RECOGNISE, encodePng, NO_TEXT_IN_PICTURE, PICTURES_NOTE, RECOGNISED, type Layer } from "./text/index.ts";

const l = (page: number, text: string, pictures: number): Layer => ({ page, text, pictures });
const TYPED = "A function f is injective if no two inputs give the same output.";
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-material-"));

describe("material (ported from material.rs)", () => {
  it("each page is typed, handwriting, a picture or unreadable", () => {
    const layers = [l(1, TYPED, 0), l(2, "", 1), l(3, TYPED, 2), l(4, "", 1), l(5, "", 0), l(6, "", 0), l(7, "", 1)];
    const copy = `# Text of notes.pdf\n\n## Page 1\n\n${TYPED}\n\n## Page 2 ${RECOGNISED}\n\nSets and subsets\n\n## Page 3\n\n${TYPED}\n\n${PICTURES_NOTE}2 pictures (figures, diagrams or photos); they can’t be read as text.)\n\n## Page 4\n\n(No text was found on this page.)\n\n## Page 5\n\n(No text was found on this page.)\n\n## Page 6\n\n(This page is handwriting or a scan, and ${CANT_RECOGNISE} it needs the tesseract program.)\n\n## Page 7\n\n(This page is handwriting or a scan, and its text couldn’t be recognised: recognising its text took too long.)`;
    const q = assessPdf("files/notes.pdf", layers, copy);
    expect(q.pages).toBe(7);
    expect(q.typed).toBe(2);
    expect(q.handwriting).toEqual([2]);
    expect(q.pictures).toEqual([[3, 2]]);
    expect(q.unreadable).toEqual([4, 6, 7]);
    expect(flaggedPages(q)).toBe(4);
    expect(picturePages(q)).toEqual([2, 4, 6, 7, 3]);
    const old = "## Page 1\n\n(This page is handwriting or a scan; text recognition needs macOS for now.)";
    expect(assessPdf("x.pdf", [l(1, "", 1)], old).unreadable).toEqual([1]);
    expect(assessPicture("files/board.jpg", `## Picture ${RECOGNISED}\n\nO(n log n)`).handwriting).toEqual([1]);
    expect(assessPicture("files/venn.png", NO_TEXT_IN_PICTURE).pictures).toEqual([[1, 1]]);
    expect(assessPicture("files/venn.png", "(This is a picture, and its text can’t be recognised on this computer: x.)").unreadable).toEqual([1]);
  });

  it("the summary says it in numbers and words", () => {
    const r: Report = {
      version: MATERIAL_VERSION,
      files: [
        { path: "files/a.pdf", pages: 10, typed: 10, size: 0, copyModified: 0 },
        { path: "files/notes.pdf", pages: 12, typed: 0, handwriting: Array.from({ length: 12 }, (_, i) => i + 1), knownWords: 0.7, size: 0, copyModified: 0 },
        { path: "files/slides.pdf", pages: 30, typed: 30, pictures: [[3, 4], [9, 5]], size: 0, copyModified: 0 },
      ],
    };
    const s = summarise(r, () => true);
    expect([s.documents, s.typedDocuments, s.handwritingPages, s.pictures, s.unreadablePages]).toEqual([3, 1, 12, 9, 0]);
    expect(s.readability).toBe("fair");
    expect(s.knownWords).toBe(0.7);
    expect(s.lines).toEqual(["12 pages are handwriting or scans: read with text recognition; expect some mistakes.", "9 pictures (figures, diagrams or photos): they can’t be read as text."]);
    expect(s.flagged.map((f) => f.path)).toEqual(["files/notes.pdf", "files/slides.pdf"]);
    expect(summarise(r, (f) => f.path === "files/a.pdf").lines).toEqual(["The document is typed text, read as it is."]);
    const none: Report = { ...r, cantRecognise: "it needs tesseract", files: [{ path: "x.pdf", pages: 2, typed: 0, unreadable: [1, 2], size: 0, copyModified: 0 }] };
    expect(summarise(none, () => true).lines).toEqual(["2 pages couldn’t be read at all: it needs tesseract."]);
    expect(JSON.stringify(summarise(none, () => true))).toBe(
      '{"documents":1,"typedDocuments":0,"handwritingPages":0,"unreadablePages":2,"pictures":0,"cantRecognise":"it needs tesseract","lines":["2 pages couldn’t be read at all: it needs tesseract."],"flagged":[{"path":"x.pdf","handwriting":0,"unreadable":2,"pictures":0}]}',
    );
  });

  it("icons are left out and a copy's picture notes follow what counts now", async () => {
    const root = temp();
    fs.mkdirSync(path.join(root, "files/Template Assets"), { recursive: true });
    const png = (w: number, h: number) => encodePng(w, h, 1, Buffer.alloc(w * h, 200), false)!;
    const noWords = `# Text of x.png\n\n${NO_TEXT_IN_PICTURE}`;
    fs.writeFileSync(path.join(root, "files/Template Assets/syllabus.png"), png(346, 346));
    fs.writeFileSync(path.join(root, "files/Template Assets/syllabus.png.md"), noWords);
    fs.writeFileSync(path.join(root, "files/venn.png"), png(800, 600));
    fs.writeFileSync(path.join(root, "files/venn.png.md"), noWords);
    fs.writeFileSync(path.join(root, "files/eq.png"), png(300, 80));
    fs.writeFileSync(path.join(root, "files/eq.png.md"), `## Picture ${RECOGNISED}\n\nx = 2y + 1`);
    fs.writeFileSync(path.join(root, "files/slides.pdf"), "%PDF-1.4 x");
    const oldNote = "(This page also shows a picture (a figure, diagram or photo); it can’t be read as text.)";
    fs.writeFileSync(path.join(root, "files/slides.pdf.md"), `# Text of slides.pdf\n\nCopied from it.\n\n## Page 1\n\n${TYPED}\n\n${oldNote}\n\n## Page 2\n\n${TYPED}\n\n${oldNote}`);
    const docs = documents(root);
    const r = await assessCourse(root, docs, undefined, async () => [l(1, TYPED, 0), l(2, TYPED, 2)]);
    expect(r.files.map((f) => f.path)).toEqual(["files/eq.png", "files/slides.pdf", "files/venn.png"]);
    expect(r.files[2].pictures).toEqual([[1, 1]]);
    expect(r.files[1].pictures).toEqual([[2, 2]]);
    expect(fs.readFileSync(path.join(root, "files/slides.pdf.md"), "utf8")).toBe(
      `# Text of slides.pdf\n\nCopied from it.\n\n## Page 1\n\n${TYPED}\n\n## Page 2\n\n${TYPED}\n\n(This page also shows 2 pictures (figures, diagrams or photos); they can’t be read as text.)`,
    );
    let calls = 0;
    const counted = async () => {
      calls++;
      return [l(1, TYPED, 0), l(2, TYPED, 2)];
    };
    expect(await assessCourse(root, docs, r, counted)).toEqual(r);
    expect(calls).toBe(0);
    await assessCourse(root, docs, { ...r, version: 1 }, counted);
    expect(calls).toBe(1);
    // Saved as JSON and read back, the report is the same.
    expect(normalizeReport(JSON.parse(JSON.stringify(r)))).toEqual(r);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a course is assessed from its copies and unchanged documents are reused", async () => {
    const root = temp();
    fs.mkdirSync(path.join(root, "files/Notes"), { recursive: true });
    fs.writeFileSync(path.join(root, "syllabus.md"), "We study sets, functions, relations and graphs.");
    fs.writeFileSync(path.join(root, "files/Notes/hand.pdf"), "%PDF-1.4 x");
    fs.writeFileSync(path.join(root, "files/Notes/hand.pdf.md"), `# Text of hand.pdf\n\n## Page 1 ${RECOGNISED}\n\nsets and fnctions and relatons\n\n## Page 2\n\n${TYPED}`);
    fs.writeFileSync(path.join(root, "files/deck.pptx"), "PK");
    fs.writeFileSync(path.join(root, "files/deck.pptx.md"), "## Slide 1\n\nGraphs");
    fs.writeFileSync(path.join(root, "files/raw.pdf"), "%PDF");
    const docs = documents(root);
    expect(docs).toEqual(["files/Notes/hand.pdf", "files/deck.pptx", "files/raw.pdf"]);
    let calls = 0;
    const layers = async () => {
      calls++;
      return [l(1, "", 1), l(2, TYPED, 0)];
    };
    const r = await assessCourse(root, docs, undefined, layers);
    expect(r.files.length).toBe(2);
    expect(r.files[0].handwriting).toEqual([1]);
    expect(r.files[0].typed).toBe(1);
    expect(r.files[0].knownWords).toBe(0.6);
    expect(calls).toBe(1);
    const again = await assessCourse(root, docs, r, layers);
    expect(calls).toBe(1);
    expect(again).toEqual(r);
    // `typed` missing (a hand-edited block) reads as 0 instead of breaking the file.
    expect(normalizeReport({ version: 2, files: [{ path: "x.pdf", pages: 1 }] })?.files[0].typed).toBe(0);
    const stop = new AbortController();
    stop.abort();
    await expect(assessCourse(root, docs, undefined, layers, stop.signal)).rejects.toThrow("cancelled");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
