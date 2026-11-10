import zlib from "node:zlib";
import { MAX_PART, MAX_SLIDES } from "./constants.ts";

/**
 * Word and PowerPoint text: just enough of the zip format (central directory,
 * stored or deflated entries, no zip64 or encryption) and a light tag scan.
 */

const u16 = (b: Buffer, i: number) => (i + 2 <= b.length ? b.readUInt16LE(i) : null);
const u32 = (b: Buffer, i: number) => (i + 4 <= b.length ? b.readUInt32LE(i) : null);

/** One file's bytes from a zip archive, by exact name; null when absent, encrypted, too big or unreadable. */
export function zipEntry(zip: Buffer, wanted: string, limit: number): Buffer | null {
  if (zip.length < 22) return null;
  const floor = Math.max(0, zip.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = zip.length - 22; i >= floor; i--) {
    if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 5 && zip[i + 3] === 6) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const entries = u16(zip, eocd + 10);
  let at = u32(zip, eocd + 16);
  if (entries === null || at === null) return null;
  const want = Buffer.from(wanted, "utf8");
  for (let e = 0; e < entries; e++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) return null;
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    if (at + 46 + nameLen > zip.length) return null;
    const name = zip.subarray(at + 46, at + 46 + nameLen);
    if (name.equals(want)) {
      if (flags & 1 || size > limit) return null;
      if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      if (start + compressed > zip.length) return null;
      const data = zip.subarray(start, start + compressed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) {
        try {
          return zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, limit) });
        } catch {
          return null;
        }
      }
      return null;
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** XML's five named entities and numeric references (the `;` within 12 bytes of the `&`). */
export function unescapeXml(s: string): string {
  if (!s.includes("&")) return s;
  let out = "";
  let rest = s;
  for (;;) {
    const i = rest.indexOf("&");
    if (i < 0) break;
    out += rest.slice(0, i);
    rest = rest.slice(i);
    const end = rest.indexOf(";");
    if (end < 0 || Buffer.byteLength(rest.slice(0, end)) > 12) {
      out += "&";
      rest = rest.slice(1);
      continue;
    }
    const entity = rest.slice(1, end);
    let ch: string | null = null;
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.prototype.hasOwnProperty.call(named, entity)) ch = named[entity];
    else {
      let cp: number | null = null;
      if (/^#[xX][0-9A-Fa-f]+$/.test(entity)) cp = parseInt(entity.slice(2), 16);
      else if (/^#\d+$/.test(entity)) cp = parseInt(entity.slice(1), 10);
      if (cp !== null && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) ch = String.fromCodePoint(cp);
    }
    if (ch !== null) {
      out += ch;
      rest = rest.slice(end + 1);
    } else {
      out += "&";
      rest = rest.slice(1);
    }
  }
  return out + rest;
}

/** Walks `<tag>`s, calling `onText` for text between tags while `inText` and `onTag` for each tag name. */
function scanTags(xml: string, textTag: string, onTag: (name: string, out: string[]) => void): string {
  const out: string[] = [];
  let inText = false;
  let rest = xml;
  for (;;) {
    const open = rest.indexOf("<");
    if (open < 0) break;
    if (inText) out.push(unescapeXml(rest.slice(0, open)));
    const close = rest.indexOf(">", open);
    if (close < 0) break;
    const tag = rest.slice(open + 1, close);
    rest = rest.slice(close + 1);
    const selfClosing = tag.endsWith("/");
    const name = tag.replace(/\/+$/, "").split(/\s/u)[0] ?? "";
    if (name === textTag) inText = !selfClosing;
    else if (name === `/${textTag}`) inText = false;
    else onTag(name, out);
  }
  return out.join("");
}

const TRAILING_WS = new RegExp("[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+$", "u");
const rustTrimEndLine = (s: string) => s.replace(TRAILING_WS, "");

/** The text of a .docx: each paragraph on its own line, tabs and line breaks kept. */
export function docxText(bytes: Buffer): string {
  const unreadable = "it couldn’t be read as a Word document (.docx)";
  const xml = zipEntry(bytes, "word/document.xml", MAX_PART);
  if (!xml) throw new Error(unreadable);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(xml);
  } catch {
    throw new Error(unreadable);
  }
  const out = scanTags(text, "w:t", (name, o) => {
    if (name === "w:tab") o.push("\t");
    else if (name === "w:br" || name === "w:cr" || name === "/w:p") o.push("\n");
  });
  return rustTrimEndLine(out);
}

/** Slide by slide: each slide's text runs, one paragraph per line, under "## Slide N". */
export function pptxText(bytes: Buffer): string {
  let out = "";
  let found = false;
  for (let n = 1; n <= MAX_SLIDES; n++) {
    const xml = zipEntry(bytes, `ppt/slides/slide${n}.xml`, MAX_PART);
    if (!xml) break;
    found = true;
    const slide = scanTags(xml.toString("utf8"), "a:t", (name, o) => {
      if (name === "a:br" || name === "/a:p") o.push("\n");
    });
    const lines = slide.split("\n");
    if (slide.endsWith("\n")) lines.pop();
    const kept = lines.map((l) => rustTrimEndLine(l.endsWith("\r") ? l.slice(0, -1) : l)).filter((l) => l.trim() !== "");
    out += `## Slide ${n}\n\n${kept.join("\n")}\n\n`;
  }
  if (!found) throw new Error("it couldn’t be read as a PowerPoint file (.pptx)");
  return rustTrimEndLine(out);
}
