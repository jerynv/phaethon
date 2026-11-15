import { canSymlinkFiles, symlink } from "../../../tests/fs.ts";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import type { Block } from "../core/thread.ts";
import { DOCX_TYPE, FOLDER, cleanName, cliNote, expandIn, removeAttachmentsIn, saveUploadsIn, today, type Upload } from "./attachments.ts";
import { docxText, unescapeXml, zipEntry } from "./docx.ts";

const env = tempHome();
afterAll(() => env.cleanup());

let n = 0;
function tempSpace(): string {
  const d = path.join(env.home, `attach-${n++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const up = (name: string, mediaType: string, bytes: Uint8Array | string): Upload => ({ name, mediaType, data: Buffer.from(bytes).toString("base64") });
const PNG = Buffer.from("\x89PNG\r\n\x1a\n\0\0\0\rIHDR", "latin1");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const MB = 1024 * 1024;

/** A zip archive with the given entries, stored or deflated (CRC left zero: not checked). */
function zip(entries: [string, Uint8Array | string, boolean][]): Buffer {
  const out: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, raw, deflate] of entries) {
    const data = Buffer.from(raw);
    const packed = deflate ? zlib.deflateRawSync(data) : data;
    const nameB = Buffer.from(name);
    const sizes = Buffer.alloc(16);
    sizes.writeUInt32LE(0, 0);
    sizes.writeUInt32LE(packed.length, 4);
    sizes.writeUInt32LE(data.length, 8);
    sizes.writeUInt16LE(nameB.length, 12);
    const method = Buffer.alloc(2);
    method.writeUInt16LE(deflate ? 8 : 0);
    const local = Buffer.concat([Buffer.from("PK\x03\x04\x14\0\0\0", "latin1"), method, Buffer.alloc(4), sizes, nameB, packed]);
    const off = Buffer.alloc(4);
    off.writeUInt32LE(offset);
    central.push(Buffer.concat([Buffer.from("PK\x01\x02\x14\0\x14\0\0\0", "latin1"), method, Buffer.alloc(4), sizes, Buffer.alloc(10), off, nameB]));
    out.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.write("PK\x05\x06", 0, "latin1");
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...out, cd, end]);
}

const DOC_XML =
  '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Test 1</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve"> Oct 14 &amp; 16 </w:t></w:r></w:p><w:p><w:r><w:t>Line</w:t><w:br/><w:t>two &#x2014; &lt;ok&gt; &#233;</w:t><w:t/></w:r></w:p></w:body></w:document>';

const paths = (refs: Block[]) => refs.map((r) => r.path as string);

describe("attachments", () => {
  it("dates are UTC days", () => {
    expect(today(0)).toBe("1970-01-01");
    expect(today(20_735 * 86_400_000)).toBe("2026-10-09");
    expect(today(11_016 * 86_400_000 + 86_399_999)).toBe("2000-02-29");
  });

  it("saves, checks and expands", () => {
    const space = tempSpace();
    const refs = saveUploadsIn(space, [up("../../evil notes.md", "", "# hi"), up("pic.png", "image/png", PNG), up("pic.png", "image/png", JPEG)]);
    const ps = paths(refs);
    expect(ps[0]!.startsWith("attachments/") && ps[0]!.endsWith("/evil notes.md")).toBe(true);
    expect(ps[2]!.endsWith("/pic (2).png")).toBe(true);
    expect(refs[2]!.media_type).toBe("image/jpeg");
    expect(refs[0]).toEqual({ type: "phaethon_attachment", path: ps[0], media_type: "text/plain", name: "../../evil notes.md" });
    expect(fs.readFileSync(path.join(space, ps[0]!), "utf8")).toBe("# hi");
    const msgs = [{ role: "user" as const, content: [refs[0]!, refs[1]!, { type: "text", text: "look" }], at: 5 }];
    const wire = expandIn(space, msgs);
    const c = wire[0]!.content;
    expect(c[0]).toMatchObject({ type: "document", source: { type: "text", data: "# hi" } });
    expect((c[1]!.source as { data: string }).data).toBe(PNG.toString("base64"));
    expect(c[2]!.text).toBe("look");
    expect("at" in wire[0]!).toBe(false);
    // A model that can't see pictures gets a note instead.
    expect(expandIn(space, msgs, { images: false, pdf: true })[0]!.content[1]!.type).toBe("text");
    fs.rmSync(path.join(space, ps[1]!));
    expect(expandIn(space, msgs)[0]!.content[1]).toEqual({ type: "text", text: "[The attached file pic.png is no longer in this space.]" });
    const dayDir = path.dirname(path.join(space, ps[0]!));
    const before = fs.readdirSync(dayDir).length;
    expect(() => saveUploadsIn(space, [up("ok.txt", "text/plain", "x"), up("a.exe", "application/x-msdownload", Buffer.from("MZ\0\0", "latin1"))])).toThrow();
    expect(() => saveUploadsIn(space, [up("bin.txt", "text/plain", Buffer.from([0xff, 0xfe, 0]))])).toThrow();
    expect(() => saveUploadsIn(space, [up("big.png", "image/png", Buffer.alloc(5 * MB + 1))])).toThrow("it’s too large (the limit is 5 MB for images)");
    expect(() => saveUploadsIn(space, [up("fake.png", "image/png", "not an image")])).toThrow("it isn’t a PNG, JPEG, GIF or WebP image");
    expect(() => saveUploadsIn(space, [up("fake.pdf", "application/pdf", "hello")])).toThrow("fake.pdf: it isn’t a PDF.");
    expect(() => saveUploadsIn(space, [{ name: "x.txt", mediaType: "", data: "not base64!" }])).toThrow("x.txt: it couldn’t be read.");
    expect(() => saveUploadsIn(space, Array.from({ length: 11 }, (_, i) => up(`${i}.txt`, "", "x")))).toThrow("You can attach up to 10 files to one message.");
    expect(fs.readdirSync(dayDir).length).toBe(before);
  });

  it("accepts any UTF-8 text by its bytes and names every refused file", () => {
    const space = tempSpace();
    const refs = saveUploadsIn(space, [
      up("main.rs", "", "fn main() {}\n"),
      up("Cargo.toml", "application/toml", '[package]\nname = "x"\n'),
      up(".env.example", "application/octet-stream", "API_URL=https://example.com\n"),
      up("Makefile", "", "build:\n\tcargo build # ✓\n"),
      up("notes.weird", "application/x-unknown", ""),
    ]);
    expect(refs.length).toBe(5);
    expect(refs.every((r) => r.media_type === "text/plain")).toBe(true);
    expect(refs[2]!.name).toBe(".env.example");
    expect((refs[2]!.path as string).endsWith("/env.example")).toBe(true);
    const wire = expandIn(space, [{ role: "user" as const, content: refs }]);
    expect(wire[0]!.content[1]).toMatchObject({ title: "Cargo.toml", source: { data: '[package]\nname = "x"\n' } });
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hi", "utf16le")]);
    let err = "";
    try {
      saveUploadsIn(space, [
        up("ok.md", "", "fine"),
        up("program", "", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1])),
        up("latin1.csv", "text/csv", Buffer.from([0x63, 0xe9])),
        up("utf16.txt", "text/plain", utf16),
        up("huge.log", "", Buffer.alloc(MB + 1, "a")),
      ]);
    } catch (e) {
      err = (e as Error).message;
    }
    expect(err.startsWith("These files weren’t attached, so nothing was sent.")).toBe(true);
    for (const name of ["program:", "latin1.csv:", "utf16.txt:", "huge.log: it’s too large (the limit is 1 MB for text files)."]) expect(err).toContain(name);
    expect(err).not.toContain("ok.md");
    expect(() => saveUploadsIn(space, [up("a.bin", "", Buffer.from([0, 1, 2]))])).toThrow(/^This file wasn’t attached, so nothing was sent\. a\.bin: it isn’t a kind of file/);
  });

  it("turns a Word document into text", () => {
    expect(docxText(zip([["word/document.xml", DOC_XML, false]]))).toBe("Test 1\t Oct 14 & 16 \nLine\ntwo — <ok> é");
    const deflated = zip([
      ["[Content_Types].xml", "<Types/>", true],
      ["word/styles.xml", "<w:styles/>", true],
      ["word/document.xml", DOC_XML, true],
    ]);
    expect(docxText(deflated).startsWith("Test 1\t Oct 14 & 16")).toBe(true);
    expect(() => docxText(Buffer.from("PK\x03\x04 nope", "latin1"))).toThrow();
    expect(() => docxText(zip([["other.xml", "<x/>", false]]))).toThrow("it couldn’t be read as a Word document (.docx)");
    // A bomb larger than the limit is refused, not unpacked.
    expect(zipEntry(zip([["word/document.xml", Buffer.alloc(4096, "a"), true]]), "word/document.xml", 1024)).toBeUndefined();
    expect(unescapeXml("a &amp;&amp; b &unknown; &#65;&#x42; & c")).toBe("a && b &unknown; AB & c");
    const space = tempSpace();
    const refs = saveUploadsIn(space, [up("Essay draft.docx", "", deflated)]);
    expect(refs[0]!.media_type).toBe(DOCX_TYPE);
    expect((refs[0]!.path as string).endsWith(".docx")).toBe(true);
    const wire = expandIn(space, [{ role: "user" as const, content: refs }]);
    expect((wire[0]!.content[0]!.source as { type: string; data: string }).type).toBe("text");
    expect((wire[0]!.content[0]!.source as { data: string }).data).toContain("Oct 14 & 16");
    expect(() => saveUploadsIn(space, [up("broken.docx", DOCX_TYPE, "not a zip")])).toThrow("broken.docx: it couldn’t be read as a Word document");
  });

  it("refuses HEIC off macOS with a plain reason", () => {
    if (process.platform === "darwin") return;
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(8)]);
    expect(() => saveUploadsIn(tempSpace(), [up("IMG_1.jpg", "image/jpeg", heic)])).toThrow("HEIC photos can be attached only on a Mac for now.");
  });

  it.skipIf(!canSymlinkFiles)("never writes through a symlink", () => {
    const space = tempSpace();
    const outside = tempSpace();
    const day = path.join(space, FOLDER, today());
    fs.mkdirSync(day, { recursive: true });
    symlink(path.join(outside, "planted.md"), path.join(day, "notes.md"));
    const refs = saveUploadsIn(space, [up("notes.md", "", "mine")]);
    expect(path.basename(refs[0]!.path as string)).toBe("notes (2).md");
    expect(fs.existsSync(path.join(outside, "planted.md"))).toBe(false);
    fs.rmSync(path.join(space, FOLDER), { recursive: true });
    symlink(outside, path.join(space, FOLDER));
    expect(() => saveUploadsIn(space, [up("a.md", "", "x")])).toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.skipIf(!canSymlinkFiles)("removes only attachments inside the space", () => {
    const space = tempSpace();
    const outside = tempSpace();
    const ps = paths(saveUploadsIn(space, [up("a.md", "", "a"), up("b.md", "", "b")]));
    fs.writeFileSync(path.join(space, "notes.md"), "mine");
    fs.writeFileSync(path.join(outside, "x.md"), "theirs");
    const bad = ["notes.md", "../x.md", "attachments", "attachments/../notes.md", ".phaethon/thread.json", "/etc/hosts"];
    expect(removeAttachmentsIn(space, bad)).toEqual({ removed: 0, failed: bad.length });
    expect(fs.existsSync(path.join(space, "notes.md")) && fs.existsSync(path.join(outside, "x.md"))).toBe(true);
    expect(removeAttachmentsIn(space, ps.slice(0, 1))).toEqual({ removed: 1, failed: 0 });
    expect(fs.existsSync(path.join(space, ps[0]!))).toBe(false);
    expect(fs.existsSync(path.join(space, ps[1]!))).toBe(true);
    expect(removeAttachmentsIn(space, ps.slice(1))).toEqual({ removed: 1, failed: 0 });
    expect(fs.existsSync(path.join(space, FOLDER, today()))).toBe(false);
    expect(fs.statSync(path.join(space, FOLDER)).isDirectory()).toBe(true);
    expect(removeAttachmentsIn(space, ps.slice(0, 1))).toEqual({ removed: 1, failed: 0 });
    const day = path.join(space, FOLDER, "2026-01-01");
    fs.mkdirSync(day, { recursive: true });
    symlink(path.join(outside, "x.md"), path.join(day, "link.md"));
    expect(removeAttachmentsIn(space, ["attachments/2026-01-01/link.md"])).toEqual({ removed: 0, failed: 1 });
    expect(fs.existsSync(path.join(outside, "x.md"))).toBe(true);
  });

  it("names files safely and tells a CLI where they are", () => {
    expect(cleanName(".env.example")).toBe("env.example");
    expect(cleanName("../../evil notes.md")).toBe("evil notes.md");
    expect(cleanName("..")).toBe("file");
    expect(cleanName("a:b*c?.txt")).toBe("a-b-c-.txt");
    const long = cleanName(`${"x".repeat(150)}.pdf`);
    expect([...long].length).toBe(100);
    expect(long.endsWith(".pdf")).toBe(true);
    expect(cliNote([])).toBe("");
    expect(cliNote([{ type: "phaethon_attachment", path: "attachments/d/a.md" }])).toBe("\n\nThe user attached these files, saved in this folder:\n- attachments/d/a.md");
  });
});
