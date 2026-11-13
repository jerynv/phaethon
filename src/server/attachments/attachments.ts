import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Refusal, messageOf } from "../rpc/registry.ts";
import { components, lstatOrNull } from "../core/fsx.ts";
import { cleanRel, resolveIn } from "../core/resolve.ts";
import { ATTACHMENT_TYPE, LEGACY_ATTACHMENT_TYPE, type Block, type Role } from "../core/thread.ts";
import { spaceDir } from "../core/vault.ts";
import { docxText } from "./docx.ts";

/**
 * Files the user attaches to a message. Each upload is checked by its bytes and
 * saved as an ordinary file in the space, `attachments/<YYYY-MM-DD>/<name>`
 * (UTC date). The thread keeps only a reference block
 * (`{"type":"phaethon_attachment","path","media_type","name"}`), expanded into
 * the API's image or document block just before each request.
 */

export const MAX_FILES = 10;
const MB = 1024 * 1024;
const MAX_IMAGE = 5 * MB;
const MAX_PDF = 30 * MB;
const MAX_TEXT = 1 * MB;
const MAX_HEIC = 30 * MB;
const MAX_DOCX = 30 * MB;
const MAX_TOTAL = 30 * MB;
export const FOLDER = "attachments";
export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type Upload = { name: string; mediaType: string; data: string };
type Kind = "image" | "pdf" | "text" | "docx" | "heic";

/** Rust's `Path::extension`, lowercased ("" when there is none). */
function extension(name: string): string {
  const base = baseName(name);
  if (!base) return "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** Rust's `Path::file_name` ("" for none or `..`). */
function baseName(name: string): string {
  const parts = components(name);
  const last = parts[parts.length - 1];
  return last === undefined || last === ".." || last === "." ? "" : last;
}

/** Rust's `Path::file_stem`. */
function fileStem(name: string): string {
  const base = baseName(name);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

function declaredKind(mediaType: string, name: string): Kind | undefined {
  const ext = extension(name);
  if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType) || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"].includes(mediaType) || ["heic", "heif"].includes(ext)) return "heic";
  if (mediaType === "application/pdf" || ext === "pdf") return "pdf";
  if (mediaType === DOCX_TYPE || ext === "docx") return "docx";
  return undefined;
}

function storedKind(mediaType: string): Kind | undefined {
  if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType)) return "image";
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType === DOCX_TYPE) return "docx";
  if (mediaType.startsWith("text/") || mediaType === "application/json") return "text";
  return undefined;
}

function starts(b: Uint8Array, sig: number[] | string, at = 0): boolean {
  const s = typeof sig === "string" ? [...Buffer.from(sig, "latin1")] : sig;
  if (b.length < at + s.length) return false;
  return s.every((x, i) => b[at + i] === x);
}

export function imageType(b: Uint8Array): string | undefined {
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(b, "GIF87a") || starts(b, "GIF89a")) return "image/gif";
  if (b.length >= 12 && starts(b, "RIFF") && starts(b, "WEBP", 8)) return "image/webp";
  return undefined;
}

export function isHeic(b: Uint8Array): boolean {
  if (b.length < 12 || !starts(b, "ftyp", 4)) return false;
  const brand = Buffer.from(b.subarray(8, 12)).toString("latin1");
  return ["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"].includes(brand);
}

function isText(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

export function isAttachmentRef(b: unknown): boolean {
  const t = (b as { type?: unknown } | null)?.type;
  return t === ATTACHMENT_TYPE || t === LEGACY_ATTACHMENT_TYPE;
}

export function reference(p: string, mediaType: string, name: string): Block {
  return { type: ATTACHMENT_TYPE, path: p, media_type: mediaType, name };
}

type Ready = { upload: Upload; fileName: string; mediaType: string; bytes: Buffer };

/** Standard alphabet with padding required, as the Rust core decoded it. */
function isBase64(s: unknown): s is string {
  return typeof s === "string" && s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);
}

function prepare(u: Upload): Ready {
  if (!isBase64(u.data)) throw new Error("it couldn’t be read");
  const bytes = Buffer.from(u.data, "base64");
  const tooBig = (limit: string) => new Error(`it’s too large (the limit is ${limit})`);
  const ready = (mediaType: string, b: Buffer, fileName = u.name): Ready => ({ upload: u, fileName, mediaType, bytes: b });
  // Phones sometimes label HEIC photos as JPEG; the bytes decide.
  const kind = isHeic(bytes) ? "heic" : declaredKind(String(u.mediaType ?? ""), String(u.name ?? ""));
  switch (kind) {
    case "image": {
      if (bytes.length > MAX_IMAGE) throw tooBig("5 MB for images");
      const t = imageType(bytes);
      if (!t) throw new Error("it isn’t a PNG, JPEG, GIF or WebP image");
      return ready(t, bytes);
    }
    case "heic": {
      if (bytes.length > MAX_HEIC) throw tooBig("30 MB for HEIC photos");
      const jpeg = heicToJpeg(bytes);
      if (jpeg.length > MAX_IMAGE) throw tooBig("5 MB for images, after converting it to JPEG");
      return ready("image/jpeg", jpeg, `${fileStem(u.name)}.jpg`);
    }
    case "pdf":
      if (bytes.length > MAX_PDF) throw tooBig("30 MB for PDFs");
      if (!starts(bytes, "%PDF-")) throw new Error("it isn’t a PDF");
      return ready("application/pdf", bytes);
    case "docx": {
      if (bytes.length > MAX_DOCX) throw tooBig("30 MB for Word documents");
      const text = docxText(bytes);
      if (Buffer.byteLength(text) > MAX_TEXT) throw new Error("it has more text than one message can carry (1 MB of text)");
      return ready(DOCX_TYPE, bytes);
    }
    default:
      if (!isText(bytes)) throw new Error("it isn’t a kind of file Phaethon can read. Attach images, PDFs, Word documents (.docx) or text files");
      if (bytes.length > MAX_TEXT) throw tooBig("1 MB for text files");
      return ready("text/plain", bytes);
  }
}

let heicCounter = 0;

/** macOS only: `sips` converts in a fresh private folder, no shell. */
function heicToJpeg(bytes: Buffer): Buffer {
  if (process.platform !== "darwin") {
    throw new Error("HEIC photos can be attached only on a Mac for now. Save it as a JPEG first, then attach that");
  }
  const failed = () => new Error("it couldn’t be converted from HEIC to JPEG");
  const dir = path.join(os.tmpdir(), `phaethon-heic-${process.pid}-${process.hrtime.bigint()}-${heicCounter++}`);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch {
    throw failed();
  }
  try {
    const input = path.join(dir, "photo.heic");
    const output = path.join(dir, "photo.jpg");
    fs.writeFileSync(input, bytes);
    const r = spawnSync("/usr/bin/sips", ["-s", "format", "jpeg", input, "--out", output], { stdio: "ignore" });
    if (r.status !== 0) throw failed();
    const jpeg = fs.readFileSync(output);
    if (imageType(jpeg) !== "image/jpeg") throw failed();
    return jpeg;
  } catch {
    throw failed();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function displayName(name: string): string {
  return baseName(String(name ?? "")) || "A file";
}

/** A safe file name: letters, digits, `.-_ ` kept, no leading dots, at most 100 characters (extension kept). */
export function cleanName(name: string): string {
  const base = baseName(name);
  let s = [...base].map((c) => (/[\p{Alphabetic}\p{N}._ -]/u.test(c) ? c : "-")).join("");
  s = s.replace(/^[. ]+/, "").replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const chars = [...s];
  if (chars.length > 100) {
    const ext = extensionOf(s);
    const extChars = [...ext].length;
    s = chars.slice(0, 100 - extChars).join("") + ext;
  }
  return s || "file";
}

/** `.ext` as Rust formats `Path::extension` (with the dot), or "". */
function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i) : "";
}

/** Today's date in UTC, `YYYY-MM-DD`. */
export function today(now: number = Date.now()): string {
  return new Date(Math.floor(now / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
}

/** Creates `name`, or `stem (n).ext`, with O_EXCL: neither a planted link nor an existing file is written through. */
function createUnique(dir: string, name: string, bytes: Uint8Array): { candidate: string; full: string } {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n < 10_000; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    const full = path.join(dir, candidate);
    // On Windows CREATE_NEW can follow a dangling file symlink before
    // checking existence. Reserve every existing directory entry, too.
    if (lstatOrNull(full)) continue;
    let fd: number;
    try {
      fd = fs.openSync(full, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    try {
      fs.writeFileSync(fd, bytes);
    } catch (e) {
      fs.closeSync(fd);
      fs.rmSync(full, { force: true });
      throw e;
    }
    fs.closeSync(fd);
    return { candidate, full };
  }
  throw new Error("too many files with this name");
}

/** Checks every upload, then saves them all or none. Returns their reference blocks; throws the sentence the UI shows. */
export function saveUploadsIn(dir: string, uploads: Upload[]): Block[] {
  if (uploads.length > MAX_FILES) throw new Refusal(`You can attach up to ${MAX_FILES} files to one message.`);
  const ready: Ready[] = [];
  const refused: string[] = [];
  for (const u of uploads) {
    try {
      ready.push(prepare(u));
    } catch (e) {
      refused.push(`${displayName(u.name)}: ${messageOf(e)}.`);
    }
  }
  if (refused.length === 1) throw new Refusal(`This file wasn’t attached, so nothing was sent. ${refused[0]}`);
  if (refused.length > 1) throw new Refusal(`These files weren’t attached, so nothing was sent.\n${refused.join("\n")}`);
  if (ready.reduce((n, r) => n + r.bytes.length, 0) > MAX_TOTAL) {
    throw new Refusal("These files are too large together (the limit is 30 MB per message), so nothing was sent.");
  }
  if (!ready.length) return [];
  const dirRel = `${FOLDER}/${today()}`;
  const target = resolveIn(dir, dirRel, false);
  const refs: Block[] = [];
  const written: string[] = [];
  for (const r of ready) {
    const name = cleanName(r.fileName);
    try {
      fs.mkdirSync(target, { recursive: true });
      // Again, now that it exists: a linked attachments folder that leads out is refused.
      const real = resolveIn(dir, dirRel, true);
      const { candidate, full } = createUnique(real, name, r.bytes);
      written.push(full);
      refs.push(reference(`${dirRel}/${candidate}`, r.mediaType, r.upload.name));
    } catch (e) {
      for (const w of written) fs.rmSync(w, { force: true });
      throw new Refusal(`${displayName(r.upload.name)} could not be saved: ${messageOf(e)}`);
    }
  }
  return refs;
}

export function saveUploads(space: string, uploads: Upload[]): Block[] {
  return saveUploadsIn(spaceDir(space), uploads);
}

// ---- Expansion -----------------------------------------------------------------

export type Sight = { images: boolean; pdf: boolean };

/**
 * Text of attached PDFs, for models that can't take a PDF itself (every
 * provider but Anthropic). Read once in the text child and kept by path,
 * size and modification time; `preparePdfTexts` fills it before a request.
 */
const PDF_TEXT_MAX = 200_000;
const pdfTexts = new Map<string, string | null>();
const pdfKey = (real: string, st: fs.Stats) => `${real}\0${st.size}\0${st.mtimeMs}`;

/** Reads the text of every PDF attached in `msgs` that isn't read yet (failures are remembered as unreadable). */
export async function preparePdfTexts(space: string, msgs: { content: Block[] }[], signal?: AbortSignal): Promise<void> {
  const dir = spaceDir(space);
  for (const m of msgs) {
    for (const b of m.content) {
      if (!isAttachmentRef(b) || storedKind(typeof b.media_type === "string" ? b.media_type : "") !== "pdf") continue;
      let real: string;
      let st: fs.Stats;
      try {
        real = resolveIn(dir, String(b.path ?? ""), true);
        st = fs.statSync(real);
      } catch {
        continue;
      }
      const key = pdfKey(real, st);
      if (pdfTexts.has(key)) continue;
      try {
        const { extract } = await import("../lms/text/index.ts");
        const text = await extract(real, signal, "pdf");
        pdfTexts.set(key, text.length > PDF_TEXT_MAX ? `${text.slice(0, PDF_TEXT_MAX)}\n\n[The rest of this PDF is left out.]` : text);
      } catch {
        if (signal?.aborted) return;
        pdfTexts.set(key, null);
      }
    }
  }
}

function pdfText(real: string): string | null | undefined {
  try {
    return pdfTexts.get(pdfKey(real, fs.statSync(real)));
  } catch {
    return undefined;
  }
}

function expandOne(dir: string, b: Block, sees: Sight): Block {
  const p = typeof b.path === "string" ? b.path : "";
  const name = typeof b.name === "string" ? b.name : p;
  const mediaType = typeof b.media_type === "string" ? b.media_type : "";
  const missing = (): Block => ({ type: "text", text: `[The attached file ${name} is no longer in this space.]` });
  let bytes: Buffer;
  let real: string;
  try {
    real = resolveIn(dir, p, true);
    bytes = fs.readFileSync(real);
  } catch {
    return missing();
  }
  const textDoc = (text: string): Block => ({ type: "document", title: name, source: { type: "text", media_type: "text/plain", data: text } });
  switch (storedKind(mediaType)) {
    case "image":
      if (!sees.images) return { type: "text", text: `[The attached picture ${name} isn’t shown: this model can’t see pictures.]` };
      return { type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } };
    case "pdf":
      if (!sees.pdf) {
        const text = pdfText(real);
        return text ? textDoc(text) : { type: "text", text: `[The attached PDF ${name} couldn’t be read as text.]` };
      }
      return { type: "document", title: name, source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } };
    case "docx":
      try {
        return textDoc(docxText(bytes));
      } catch {
        return { type: "text", text: `[The attached Word document ${name} can no longer be read.]` };
      }
    case "text":
      return textDoc(new TextDecoder("utf-8").decode(bytes));
    default:
      return missing();
  }
}

/**
 * Reference blocks become the files' content for the model, deterministically
 * (prompt caching). A message with references keeps only role and content.
 */
export function expandIn<M extends { role: Role; content: Block[] }>(dir: string, msgs: M[], sees: Sight = { images: true, pdf: true }): (M | { role: Role; content: Block[] })[] {
  return msgs.map((m) => {
    if (!Array.isArray(m.content) || !m.content.some(isAttachmentRef)) return m;
    return { role: m.role, content: m.content.map((b) => (isAttachmentRef(b) ? expandOne(dir, b, sees) : b)) };
  });
}

export function expandForProvider<M extends { role: Role; content: Block[] }>(space: string, msgs: M[], sees: Sight = { images: true, pdf: true }) {
  return expandIn(spaceDir(space), msgs, sees);
}

/** What a CLI backend is told instead (it reads files itself). */
export function cliNote(refs: Block[]): string {
  if (!refs.length) return "";
  return `\n\nThe user attached these files, saved in this folder:\n${refs.map((r) => `- ${typeof r.path === "string" ? r.path : ""}`).join("\n")}`;
}

// ---- Removal -------------------------------------------------------------------

/** Deletes attachment files (only under `attachments/` in this space); an emptied date folder goes too. */
export function removeAttachmentsIn(dir: string, paths: string[]): { removed: number; failed: number } {
  let removed = 0;
  let failed = 0;
  for (const p of paths) {
    let parts: string[];
    try {
      parts = cleanRel(p);
    } catch {
      failed++;
      continue;
    }
    if (parts.length < 2 || parts[0] !== FOLDER) {
      failed++;
      continue;
    }
    let full: string;
    try {
      full = resolveIn(dir, p, true);
    } catch (e) {
      if (messageOf(e).endsWith("does not exist")) removed++;
      else failed++;
      continue;
    }
    try {
      if (!lstatOrNull(full)?.isFile()) throw new Error("not a file");
      fs.rmSync(full);
    } catch {
      failed++;
      continue;
    }
    removed++;
    try {
      const folder = resolveIn(dir, FOLDER, true);
      const parent = path.dirname(full);
      if (path.dirname(parent) === folder) fs.rmdirSync(parent);
    } catch {
      // Not empty, or already gone.
    }
  }
  return { removed, failed };
}

export function removeAttachments(space: string, paths: string[]): { removed: number; failed: number } {
  return removeAttachmentsIn(spaceDir(space), paths);
}
