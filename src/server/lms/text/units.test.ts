import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { docxText, pptxText, unescapeXml } from "./office.ts";
import { PdfDoc } from "./pdfobj.ts";
import { contentCounts, drawn, pagePicture, pagePictures } from "./pictures.ts";
import { crc32, encodePng, pngSizeOf } from "./png.ts";
import { sample, slides, storedZip } from "./test-pdfs.ts";

describe("png (ported from png.rs)", () => {
  it("crc and a png that reads back", () => {
    expect(crc32(Buffer.from("IEND"))).toBe(0xae426082);
    const px = Buffer.from(Array.from({ length: 12 }, (_, i) => i));
    const png = encodePng(4, 3, 1, px, false)!;
    expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(pngSizeOf(png)).toEqual([4, 3]);
    const at = png.indexOf("IDAT");
    const len = png.readUInt32BE(at - 4);
    expect([...zlib.inflateSync(png.subarray(at + 4, at + 4 + len))]).toEqual([0, 0, 1, 2, 3, 0, 4, 5, 6, 7, 0, 8, 9, 10, 11]);
    expect(encodePng(4, 3, 1, px.subarray(0, 11), false)).toBeNull();
    expect(encodePng(4, 3, 2, px, false)).toBeNull();
    expect(pngSizeOf(Buffer.from("not a picture"))).toBeNull();
    expect(pngSizeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 3, 0, 0, 0]))).toEqual([30, 20]);
  });
});

describe("office documents", () => {
  it("a pptx reads slide by slide", () => {
    const pptx = storedZip([
      ["ppt/slides/slide1.xml", "<p:sld><a:p><a:r><a:t>Limits &amp; continuity</a:t></a:r></a:p><a:p><a:r><a:t>Week 1</a:t></a:r></a:p></p:sld>"],
      ["ppt/slides/slide2.xml", "<p:sld><a:p><a:r><a:t>Derivatives</a:t></a:r></a:p></p:sld>"],
    ]);
    expect(pptxText(pptx)).toBe("## Slide 1\n\nLimits & continuity\nWeek 1\n\n## Slide 2\n\nDerivatives");
    expect(() => pptxText(Buffer.from("not a zip"))).toThrow("it couldn’t be read as a PowerPoint file (.pptx)");
  });

  it("a docx keeps paragraphs, tabs and breaks, deflated or stored", () => {
    const xml = '<w:document><w:body><w:p><w:r><w:t>Week&#160;1:</w:t><w:tab/><w:t xml:space="preserve">Sets &lt;intro&gt;</w:t></w:r></w:p><w:p><w:r><w:t>Line</w:t><w:br/><w:t>two</w:t></w:r></w:p></w:body></w:document>';
    const want = "Week 1:\tSets <intro>\nLine\ntwo";
    expect(docxText(storedZip([["word/document.xml", xml]]))).toBe(want);
    // A deflated entry (as Word writes them), built with the stored zip's layout.
    const raw = zlib.deflateRawSync(Buffer.from(xml));
    const z = storedZip([["word/document.xml", "x".repeat(raw.length)]]);
    const start = 30 + "word/document.xml".length;
    raw.copy(z, start);
    z.writeUInt16LE(8, 8);
    z.writeUInt32LE(Buffer.byteLength(xml), 22);
    const cd = z.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    z.writeUInt16LE(8, cd + 10);
    z.writeUInt32LE(Buffer.byteLength(xml), cd + 24);
    expect(docxText(z)).toBe(want);
    expect(() => docxText(Buffer.from("PK"))).toThrow("it couldn’t be read as a Word document (.docx)");
    expect(unescapeXml("a &amp; &#x41; &bogus; & &verylongentityname;")).toBe("a & A &bogus; & &verylongentityname;");
  });
});

describe("pictures (ported from pictures.rs)", () => {
  it("pictures a page draws are found and shared ones it doesn't draw aren't", () => {
    const doc = PdfDoc.load(sample());
    expect(doc.pages.length).toBe(3);
    const p1 = pagePictures(doc, doc.pages[0]);
    expect(p1.length).toBe(2);
    expect(p1[0].drawn).toEqual([72, 300, 372, 500]);
    const p3 = pagePictures(doc, doc.pages[2]);
    expect(p3[1].drawn).toEqual([300, 400, 500, 600]);
    const d = doc.pages.map((p) => drawn(doc, p, true));
    expect(contentCounts(d)).toEqual([1, 0, 2]);
    const png = pagePicture(doc, doc.pages[0])!;
    expect(png.mime).toBe("image/png");
    expect(pngSizeOf(png.bytes)).toEqual([300, 200]);
    const jpeg = pagePicture(doc, doc.pages[2])!;
    expect(jpeg.mime).toBe("image/jpeg");
    expect([jpeg.bytes[0], jpeg.bytes[1]]).toEqual([0xff, 0xd8]);
    expect(pagePicture(doc, doc.pages[1])).toBeNull();
  });

  it("a template's pictures are decoration and real figures count", () => {
    const doc = PdfDoc.load(slides());
    const d = doc.pages.map((p) => drawn(doc, p, true));
    expect(contentCounts(d)).toEqual([0, 0, 1, 0]);
    const noText = d.map((x) => ({ ...x }));
    noText[1].hasText = false;
    expect(contentCounts(noText)).toEqual([0, 1, 1, 0]);
    expect(contentCounts(d.slice(2))).toEqual([2, 1]);
  });

  it("odd PDFs never throw", () => {
    for (const junk of ["", "%PDF-1.4 nothing", "1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj", "1 0 obj << /Length 99999 >> stream\nabc"]) {
      const doc = PdfDoc.load(Buffer.from(junk, "latin1"));
      expect(doc.pages.length).toBe(0);
    }
  });
});
