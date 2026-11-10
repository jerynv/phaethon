import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { assemble, copyIsStale, extract, kindOf, NO_TEXT_COPY, ocrAvailability, pagePictures, pdfLayers, withPictureNotes, type Layer, type OcrPage } from "./index.ts";
import { CANT_RECOGNISE, NO_OCR } from "./constants.ts";
import { closePdf, openPdf, renderGreyPixels } from "./pdf.ts";
import { greyPdf, sample, storedZip, testPdf } from "./test-pdfs.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-text-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = (name: string, bytes: Buffer | string) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
};

/** Grey pixels of a page showing `text`, drawn at 150 dpi. */
async function textPixels(text: string) {
  const doc = await openPdf(testPdf(text));
  const px = (await renderGreyPixels(doc, 1, 150, 4000))!;
  await closePdf(doc);
  return px;
}

describe("text copies (ported from text.rs and tests/text_child.rs)", () => {
  it("a PDF's text is read in a child, and junk is an error, not a crash", async () => {
    const text = await extract(file("limits.pdf", testPdf("Chapter 1: Limits")));
    expect(text).toContain("Chapter 1: Limits");
    expect(text.startsWith("## Page 1")).toBe(true);
    await expect(extract(file("junk.pdf", "%PDF-1.4 nothing else"))).rejects.toThrow(/^it couldn’t be read as a PDF/);
    await expect(extract(file("empty.pdf", ""))).rejects.toThrow();
    expect(await extract(file("week3.pdf", testPdf("Week 3: Hash tables and their load factor")))).toBe("## Page 1\n\nWeek 3: Hash tables and their load factor");
  });

  it("pages without text are recognised, marked or explained", () => {
    const layer = "Printed heading and a paragraph with plenty of words in it";
    const l = (page: number, text: string, pictures: number): Layer => ({ page, text, pictures });
    const pages = [l(1, layer, 2), l(2, "", 1), l(3, "", 0), l(4, "Fig. 2", 0), l(5, "", 0), l(6, "", 0), l(7, layer, 1)];
    const r = new Map<number, OcrPage>([
      [2, { text: "Binary search trees\nO(log n) lookups" }],
      [3, { failed: "recognising its text took too long" }],
      [4, { text: "" }],
      [5, { text: "  " }],
    ]);
    let md = assemble(pages, r, null);
    expect(md.startsWith(`## Page 1\n\n${layer}\n\n(This page also shows 2 pictures (figures, diagrams or photos); they can’t be read as text.)\n\n`)).toBe(true);
    expect(md.endsWith(`## Page 7\n\n${layer}\n\n(This page also shows a picture (a figure, diagram or photo); it can’t be read as text.)`)).toBe(true);
    expect(md).not.toContain("lookups\n\n(This page also");
    expect(md).toContain("## Page 2 (recognised from handwriting or a scan; may contain mistakes)\n\nBinary search trees\nO(log n) lookups\n\n");
    expect(md).toContain("## Page 3\n\n(This page is handwriting or a scan, and its text couldn’t be recognised: recognising its text took too long.)");
    expect(md).toContain("## Page 4\n\nFig. 2\n\n");
    expect(md).toContain("## Page 5\n\n(No text was found on this page.)");
    expect(md).toContain("## Page 6\n\n(This page has no text, and only the first 300");
    md = assemble(pages, new Map(), "it needs the tesseract program");
    expect(md).toContain("## Page 2\n\n(This page is handwriting or a scan, and its text can’t be recognised on this computer: it needs the tesseract program.)");
    expect(md).toContain("## Page 4\n\nFig. 2");
  });

  it("a page with no text layer is recognised here or explained", async () => {
    const md = await extract(file("blank.pdf", testPdf("")));
    if (ocrAvailability() === null) expect(md).toBe("## Page 1\n\n(No text was found on this page.)");
    else expect(md).toContain(CANT_RECOGNISE);
    expect(await extract(file("typed.pdf", testPdf("Chapter 1: Limits, continuity and the squeeze theorem")))).toBe("## Page 1\n\nChapter 1: Limits, continuity and the squeeze theorem");
  }, 60000);

  it.skipIf(ocrAvailability() !== null)(
    "scanned pages and pictures get their text recognised",
    async () => {
      const { w, h, grey } = await textPixels("Chapter 1: Limits");
      const md = await extract(file("scan.pdf", greyPdf(w, h, grey)));
      expect(md.startsWith("## Page 1 (recognised from handwriting or a scan; may contain mistakes)\n\n")).toBe(true);
      expect(md).toContain("Chapter 1: Limits");

      // A picture file (24-bit BMP, written by hand) of the same page.
      const row = Math.ceil((w * 3) / 4) * 4;
      const head = Buffer.alloc(54);
      head.write("BM", 0, "latin1");
      head.writeUInt32LE(54 + row * h, 2);
      head.writeUInt32LE(54, 10);
      head.writeUInt32LE(40, 14);
      head.writeInt32LE(w, 18);
      head.writeInt32LE(h, 22);
      head.writeUInt16LE(1, 26);
      head.writeUInt16LE(24, 28);
      head.writeUInt32LE(row * h, 34);
      const body = Buffer.alloc(row * h);
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * w;
        for (let x = 0; x < w; x++) body.fill(grey[src + x], y * row + x * 3, y * row + x * 3 + 3);
      }
      const pic = file("board.bmp", Buffer.concat([head, body]));
      expect(kindOf(pic)).toBe("picture");
      const pmd = await extract(pic);
      expect(pmd.startsWith("## Picture (recognised from handwriting or a scan; may contain mistakes)\n\n")).toBe(true);
      expect(pmd).toContain("Chapter 1: Limits");
      fs.writeFileSync(pic, "not a picture");
      expect((await extract(pic)).startsWith("(Any text in this picture couldn’t be recognised")).toBe(true);
    },
    120000,
  );

  it("copies missing pages are made again", () => {
    const md = path.join(dir, "notes.pdf.md");
    expect(copyIsStale(md)).toBe(true);
    const write = (s: string) => fs.writeFileSync(md, s);
    write("# Text of notes.pdf\n\nCopied from…\n\n## Page 1\n\n\n\n## Page 2\n\nText\n");
    expect(copyIsStale(md)).toBe(true);
    write("# Text of notes.pdf\n\n## Page 1\n\nText\n\n## Page 2\n");
    expect(copyIsStale(md)).toBe(true);
    write(`# Text of scan.pdf\n\n${NO_TEXT_COPY}\n`);
    expect(copyIsStale(md)).toBe(true);
    write("# Text of notes.pdf\n\n## Page 1 (recognised from handwriting or a scan; may contain mistakes)\n\nTrees\n\n## Page 2\n\n(No text was found on this page.)\n");
    expect(copyIsStale(md)).toBe(false);
    write(`# Text of notes.pdf\n\n## Page 1\n\n${NO_OCR}\n`);
    expect(copyIsStale(md)).toBe(ocrAvailability() === null);
    write("# Text of notes.pdf\n\n## Page 1\n\n(This page is handwriting or a scan, and its text can’t be recognised on this computer: it needs tesseract.)\n");
    expect(copyIsStale(md)).toBe(ocrAvailability() === null);
    // An empty Word document's copy is current: not read again on every import.
    const docx = path.join(dir, "empty.docx.md");
    fs.writeFileSync(docx, `# Text of empty.docx\n\nCopied from [empty.docx](empty.docx) so it can be read here. Layout, pictures and equations may be missing; the file itself is the original.\n\n${NO_TEXT_COPY}\n`);
    expect(copyIsStale(docx)).toBe(false);
    fs.writeFileSync(docx, "# Text of empty.docx\n\n(This file has no text in it.)\n");
    expect(copyIsStale(docx)).toBe(true);
  });

  it("a copy's picture notes follow the pages' pictures", () => {
    const typed = "A function f is injective if no two inputs give the same output.";
    const old = "(This page also shows a picture (a figure, diagram or photo); it can’t be read as text.)";
    const copy = `# Text of slides.pdf\n\n## Page 1\n\n${typed}\n\n${old}\n\n## Page 2\n\n${typed}\n`;
    const fixed = withPictureNotes(copy, [
      { page: 1, text: typed, pictures: 0 },
      { page: 2, text: typed, pictures: 2 },
    ]);
    expect(fixed).toBe(`# Text of slides.pdf\n\n## Page 1\n\n${typed}\n\n## Page 2\n\n${typed}\n\n(This page also shows 2 pictures (figures, diagrams or photos); they can’t be read as text.)\n`);
    expect(withPictureNotes(fixed!, [
      { page: 1, text: typed, pictures: 0 },
      { page: 2, text: typed, pictures: 2 },
    ])).toBeNull();
  });

  it("Word and PowerPoint copies, and other files refused", async () => {
    const pptx = storedZip([["ppt/slides/slide1.xml", "<p:sld><a:p><a:r><a:t>Derivatives</a:t></a:r></a:p></p:sld>"]]);
    expect(await extract(file("deck.pptx", pptx))).toBe("## Slide 1\n\nDerivatives");
    expect(await extract(file("doc.docx", storedZip([["word/document.xml", "<w:p><w:r><w:t>Hello</w:t></w:r></w:p>"]])))).toBe("Hello");
    await expect(extract(file("notes.txt", "x"))).rejects.toThrow("not a document Phaethon can read");
    const stop = new AbortController();
    stop.abort();
    await expect(extract(path.join(dir, "limits.pdf"), stop.signal)).rejects.toThrow(/^cancelled$/);
  });

  it("a cancel stops the PDF reader", async () => {
    const stop = new AbortController();
    const p = pdfLayers(path.join(dir, "limits.pdf"), stop.signal);
    stop.abort();
    await expect(p).rejects.toThrow(/^cancelled$/);
  });

  it("layers count a page's pictures, and page pictures come back drawn or as stored", async () => {
    const layers = await pdfLayers(file("sample.pdf", sample()));
    expect(layers.map((l) => l.pictures)).toEqual([1, 0, 2]);
    expect(layers[0].text).toBe("A typed paragraph with plenty of words on it.");
    const typed = await pagePictures(path.join(dir, "typed.pdf"), [1, 2]);
    expect(typed.map((p) => [p.page, p.mime])).toEqual([[1, "image/png"]]);
    const { w, h, grey } = await textPixels("Chapter 1: Limits");
    const scan = await pagePictures(file("scan2.pdf", greyPdf(w, h, grey)), [1]);
    expect(scan.length).toBe(1);
    expect(scan[0].mime).toBe("image/png");
    expect(await pagePictures(path.join(dir, "junk.pdf"), [1])).toEqual([]);
    expect(await pagePictures(path.join(dir, "typed.pdf"), [])).toEqual([]);
  }, 60000);
});
