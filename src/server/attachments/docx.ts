import zlib from "node:zlib";

/**
 * Text from a Word document (.docx): a minimal zip reader for one entry
 * (stored or deflated, no zip64, CRC not checked) with a cap on the unpacked
 * size, so a zip bomb is refused rather than unpacked.
 */

const MAX_DOCX_XML = 64 * 1024 * 1024;

function u16(b: Uint8Array, i: number): number | undefined {
  return i + 2 <= b.length ? b[i]! | (b[i + 1]! << 8) : undefined;
}

function u32(b: Uint8Array, i: number): number | undefined {
  return i + 4 <= b.length ? (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)) + b[i + 3]! * 0x1000000 : undefined;
}

function startsWith(b: Uint8Array, at: number, sig: number[]): boolean {
  if (at < 0 || at + sig.length > b.length) return false;
  return sig.every((x, k) => b[at + k] === x);
}

const EOCD = [0x50, 0x4b, 0x05, 0x06];
const CENTRAL = [0x50, 0x4b, 0x01, 0x02];
const LOCAL = [0x50, 0x4b, 0x03, 0x04];

/** The bytes of entry `wanted`, or undefined (missing, encrypted, too large, damaged, unknown method). */
export function zipEntry(zip: Uint8Array, wanted: string, limit: number): Uint8Array | undefined {
  if (zip.length < 22) return undefined;
  const floor = Math.max(0, zip.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = zip.length - 22; i >= floor; i--) {
    if (startsWith(zip, i, EOCD)) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return undefined;
  const entries = u16(zip, eocd + 10);
  let at = u32(zip, eocd + 16);
  if (entries === undefined || at === undefined) return undefined;
  const want = Buffer.from(wanted, "utf8");
  for (let n = 0; n < entries; n++) {
    if (!startsWith(zip, at, CENTRAL)) return undefined;
    const flags = u16(zip, at + 8);
    const method = u16(zip, at + 10);
    const compressed = u32(zip, at + 20);
    const size = u32(zip, at + 24);
    const nameLen = u16(zip, at + 28);
    const extraLen = u16(zip, at + 30);
    const commentLen = u16(zip, at + 32);
    const local = u32(zip, at + 42);
    if ([flags, method, compressed, size, nameLen, extraLen, commentLen, local].some((v) => v === undefined)) return undefined;
    if (at + 46 + nameLen! > zip.length) return undefined;
    const name = zip.subarray(at + 46, at + 46 + nameLen!);
    if (Buffer.compare(Buffer.from(name), want) === 0) {
      if (flags! & 1 || size! > limit) return undefined;
      if (!startsWith(zip, local!, LOCAL)) return undefined;
      const ln = u16(zip, local! + 26);
      const le = u16(zip, local! + 28);
      if (ln === undefined || le === undefined) return undefined;
      const start = local! + 30 + ln + le;
      if (start + compressed! > zip.length) return undefined;
      const data = zip.subarray(start, start + compressed!);
      if (method === 0) return Uint8Array.from(data);
      if (method === 8) {
        try {
          return zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, limit) });
        } catch {
          return undefined;
        }
      }
      return undefined;
    }
    at += 46 + nameLen! + extraLen! + commentLen!;
  }
  return undefined;
}

const UNREADABLE = "it couldn’t be read as a Word document (.docx)";

/** The document's text: runs, tabs, breaks and paragraphs. Throws with the attachment refusal reason. */
export function docxText(bytes: Uint8Array): string {
  const xmlBytes = zipEntry(bytes, "word/document.xml", MAX_DOCX_XML);
  if (!xmlBytes) throw new Error(UNREADABLE);
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(xmlBytes);
  } catch {
    throw new Error(UNREADABLE);
  }
  let out = "";
  let inText = false;
  let pos = 0;
  for (;;) {
    const open = xml.indexOf("<", pos);
    if (open < 0) break;
    if (inText) out += unescapeXml(xml.slice(pos, open));
    const close = xml.indexOf(">", open);
    if (close < 0) break;
    const tag = xml.slice(open + 1, close);
    pos = close + 1;
    const selfClosing = tag.endsWith("/");
    const name = tag.replace(/\/+$/, "").split(/\s/u)[0] ?? "";
    switch (name) {
      case "w:t":
        inText = !selfClosing;
        break;
      case "/w:t":
        inText = false;
        break;
      case "w:tab":
        out += "\t";
        break;
      case "w:br":
      case "w:cr":
      case "/w:p":
        out += "\n";
        break;
    }
  }
  return out.replace(/\p{White_Space}+$/u, "");
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML entities; an unknown one, or one whose `;` is more than 12 bytes on, stays as written. */
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
    let ch: string | undefined = NAMED[entity];
    if (ch === undefined) {
      let code: number | undefined;
      if (/^#[xX][0-9a-fA-F]+$/.test(entity)) code = parseInt(entity.slice(2), 16);
      else if (/^#[0-9]+$/.test(entity)) code = parseInt(entity.slice(1), 10);
      if (code !== undefined && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) ch = String.fromCodePoint(code);
    }
    if (ch !== undefined) {
      out += ch;
      rest = rest.slice(end + 1);
    } else {
      out += "&";
      rest = rest.slice(1);
    }
  }
  return out + rest;
}
