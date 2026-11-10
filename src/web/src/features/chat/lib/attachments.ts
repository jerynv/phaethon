/**
 * Files the user can attach to a message. The rules mirror the core's
 * attachment checks, which check every file again before saving it into the
 * space: this side only exists to say no early and in plain words.
 */

export type AttachmentKind = "image" | "pdf" | "word" | "text";

const MB = 1024 * 1024;
export const LIMITS: Record<AttachmentKind, { bytes: number; label: string }> = {
  image: { bytes: 5 * MB, label: "5 MB for images" },
  pdf: { bytes: 30 * MB, label: "30 MB for PDFs" },
  word: { bytes: 10 * MB, label: "10 MB for Word documents" },
  text: { bytes: 1 * MB, label: "1 MB for text and code files" },
};
export const MAX_FILES = 10;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/heif"]);
const IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};
const WORD_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/** Files that are certainly not text; anything else without a known type is offered as text (the core checks). */
const BINARY_EXTENSIONS = new Set([
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "dmg", "pkg", "exe", "msi", "dll", "so", "dylib", "app",
  "bin", "iso", "img", "class", "jar", "o", "a", "wasm", "pyc", "mp3", "m4a", "wav", "flac", "aac", "ogg",
  "mp4", "mov", "m4v", "avi", "mkv", "webm", "doc", "xls", "xlsx", "ppt", "pptx", "key", "pages", "numbers",
  "psd", "ai", "sketch", "fig", "tif", "tiff", "bmp", "ico", "icns", "ttf", "otf", "woff", "woff2", "sqlite", "db",
]);

const extension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export function attachmentKind(file: { name: string; type: string }): AttachmentKind | null {
  const type = file.type.toLowerCase();
  const ext = extension(file.name);
  if (IMAGE_TYPES.has(type) || ext in IMAGE_EXTENSIONS) return "image";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type === WORD_TYPE || ext === "docx") return "word";
  if (type.startsWith("text/") || type === "application/json") return "text";
  if (BINARY_EXTENSIONS.has(ext)) return null;
  if (type.startsWith("image/") || type.startsWith("audio/") || type.startsWith("video/")) return null;
  return "text";
}

/** The media type sent to the core; text files without one are sent as plain text. */
export function mediaTypeOf(file: { name: string; type: string }): string {
  const kind = attachmentKind(file);
  const ext = extension(file.name);
  if (kind === "text") return file.type.startsWith("text/") || file.type === "application/json" ? file.type : "text/plain";
  if (kind === "pdf") return "application/pdf";
  if (kind === "word") return WORD_TYPE;
  if (kind === "image") return IMAGE_TYPES.has(file.type) ? file.type : (IMAGE_EXTENSIONS[ext] ?? file.type);
  return file.type;
}

const KINDS_SENTENCE = "Attach images, PDFs, Word documents, or text or code files.";

/** Why `file` cannot be attached, in a sentence, or null if it can. */
export function attachmentProblem(file: { name: string; type: string; size: number }): string | null {
  const kind = attachmentKind(file);
  if (!kind) return `${file.name} can’t be attached. ${KINDS_SENTENCE}`;
  if (file.size > LIMITS[kind].bytes) return `${file.name} is too large (the limit is ${LIMITS[kind].label}).`;
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}

/** "a", "a and b", "a, b and c". */
export function listNames(names: string[]) {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Splits a batch into the files that can be added (up to `room` more) and
 * the sentences saying why the others can't.
 */
export function admit<T extends { name: string; type: string; size: number }>(files: T[], room: number): { ok: T[]; problems: string[] } {
  const ok: T[] = [];
  const problems: string[] = [];
  const unsupported: string[] = [];
  const over: string[] = [];
  for (const f of files) {
    const kind = attachmentKind(f);
    if (!kind) {
      unsupported.push(f.name);
      continue;
    }
    const p = attachmentProblem(f);
    if (p) problems.push(p);
    else if (ok.length < room) ok.push(f);
    else over.push(f.name);
  }
  if (unsupported.length === 1) problems.unshift(`${unsupported[0]} can’t be attached. ${KINDS_SENTENCE}`);
  else if (unsupported.length > 1) problems.unshift(`${unsupported.length} files can’t be attached: ${listNames(unsupported)}. ${KINDS_SENTENCE}`);
  if (over.length) problems.push(`A message can carry up to ${MAX_FILES} files, so ${listNames(over)} ${over.length === 1 ? "wasn’t" : "weren’t"} added.`);
  return { ok, problems };
}

/** "PNG", "PDF", "Markdown"... */
export function typeLabel(name: string, mediaType: string | undefined): string {
  const ext = extension(name);
  if (mediaType === "application/pdf" || ext === "pdf") return "PDF";
  if (ext === "md" || ext === "markdown") return "Markdown";
  if (ext === "docx") return "Word";
  if (mediaType?.startsWith("image/")) return (mediaType.split("/")[1] ?? "image").toUpperCase().replace("JPEG", "JPG");
  if (ext) return ext.toUpperCase();
  return mediaType?.startsWith("text/") ? "Text" : "File";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

/** Base64 of the bytes, without a `data:` prefix. */
export async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
