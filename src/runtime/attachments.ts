import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from "@assistant-ui/react";

/**
 * Files the user can attach to a message. The rules mirror
 * src-tauri/src/attachments.rs, which checks every file again before saving it
 * into the space: this side only exists to say no early and in plain words.
 */

export type AttachmentKind = "image" | "pdf" | "text";

const MB = 1024 * 1024;
export const LIMITS: Record<AttachmentKind, { bytes: number; label: string }> = {
  image: { bytes: 5 * MB, label: "5 MB for images" },
  pdf: { bytes: 30 * MB, label: "30 MB for PDFs" },
  text: { bytes: 1 * MB, label: "1 MB for text files" },
};
/** The same cap as the Rust side (`MAX_FILES`). */
export const MAX_FILES = 10;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "csv", "json", "tsv", "log"]);

/** For the file picker. Browsers often report "" for .md and friends, hence the extensions. */
export const ACCEPT = [
  ...IMAGE_TYPES,
  "application/pdf",
  "text/*",
  "application/json",
  ...[...TEXT_EXTENSIONS].map((e) => `.${e}`),
].join(",");

/** What the user is told the composer takes. */
export const ACCEPTED_SUMMARY = "Images (PNG, JPEG, GIF, WebP), PDFs and text files";

const extension = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export function attachmentKind(file: { name: string; type: string }): AttachmentKind | null {
  const type = file.type.toLowerCase();
  if (IMAGE_TYPES.has(type)) return "image";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("text/") || type === "application/json") return "text";
  if (type === "" || type === "application/octet-stream") {
    const ext = extension(file.name);
    if (TEXT_EXTENSIONS.has(ext)) return "text";
    if (ext === "pdf") return "pdf";
  }
  return null;
}

/** The media type sent to the backend; text files without one are sent as plain text. */
export function mediaTypeOf(file: { name: string; type: string }): string {
  const kind = attachmentKind(file);
  if (kind === "text") return file.type || "text/plain";
  if (kind === "pdf") return "application/pdf";
  return file.type;
}

/** Why `file` cannot be attached, in a sentence, or null if it can. */
export function attachmentProblem(file: { name: string; type: string; size: number }): string | null {
  const kind = attachmentKind(file);
  if (!kind) return `${file.name} can’t be attached. Attach images (PNG, JPEG, GIF, WebP), PDFs or text files.`;
  if (file.size > LIMITS[kind].bytes) return `${file.name} is too large (the limit is ${LIMITS[kind].label}).`;
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}

/** "PNG", "PDF", "Markdown"... for a chip's second line. */
export function typeLabel(name: string, mediaType: string | undefined): string {
  const ext = extension(name);
  if (mediaType === "application/pdf" || ext === "pdf") return "PDF";
  if (ext === "md" || ext === "markdown") return "Markdown";
  if (mediaType?.startsWith("image/")) return (mediaType.split("/")[1] ?? "image").toUpperCase().replace("JPEG", "JPG");
  if (ext) return ext.toUpperCase();
  return mediaType?.startsWith("text/") ? "Text" : "File";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}

/** Base64 of the file's bytes, without a `data:` prefix. */
export async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

let counter = 0;

/**
 * The composer's attachment adapter. A file is checked when added; its bytes
 * are read (as base64, into a `file` part) only when the message is sent.
 */
export const attachmentAdapter: AttachmentAdapter = {
  accept: ACCEPT,
  async add({ file }): Promise<PendingAttachment> {
    const problem = attachmentProblem(file);
    if (problem) throw new Error(problem);
    return {
      id: `att-${Date.now().toString(36)}-${(counter++).toString(36)}`,
      type: attachmentKind(file) === "image" ? "image" : "document",
      name: file.name,
      contentType: mediaTypeOf(file),
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  },
  async send(attachment): Promise<CompleteAttachment> {
    const data = await toBase64(attachment.file);
    return {
      ...attachment,
      status: { type: "complete" },
      content: [
        {
          type: "file",
          data,
          mimeType: attachment.contentType ?? mediaTypeOf(attachment.file),
          filename: attachment.name,
        },
      ],
    };
  },
  async remove() {
    // Nothing is uploaded until the message is sent.
  },
};
