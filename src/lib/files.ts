import { invoke } from "@tauri-apps/api/core";

/** Mirrors `ViewKind` in src-tauri/src/viewer.rs. */
export type ViewKind = "markdown" | "tex" | "text" | "pdf" | "image" | "other";

/** Mirrors `FileView` in src-tauri/src/viewer.rs. */
export type FileView = {
  path: string;
  name: string;
  kind: ViewKind;
  size: number;
  mediaType: string;
  text: string | null;
  language: string | null;
  tooBig: boolean;
};

/** A file in the space (or a course it may see) for the viewer; text comes inline. */
export const fileView = (space: string, path: string) => invoke<FileView>("file_view", { space, path });

/** A PDF's or a picture's bytes in the space, for the viewer. */
export const fileBytes = (space: string, path: string) => invoke<ArrayBuffer>("file_bytes", { space, path });

const TEXT_EXT = new Set([
  "txt", "text", "log", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "xml", "html", "htm", "css", "js", "mjs", "ts", "tsx",
  "jsx", "py", "rb", "rs", "go", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "r", "lua", "bib",
]);

/** What a file the viewer gets as bytes (an attachment) is, by its media type or name. */
export function kindOfFile(name: string, mediaType: string | undefined): ViewKind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const mt = mediaType ?? "";
  if (mt === "application/pdf" || ext === "pdf") return "pdf";
  if (mt.startsWith("image/") && /^(png|jpe?g|gif|webp|bmp|svg)$/.test(ext || "png")) return "image";
  if (ext === "md" || ext === "markdown" || mt === "text/markdown") return "markdown";
  if (ext === "tex" || ext === "latex") return "tex";
  if (mt.startsWith("text/") || mt === "application/json" || TEXT_EXT.has(ext)) return "text";
  return "other";
}

/** The media type of an image by its name, for a data: address. */
export function imageType(name: string, mediaType?: string): string {
  if (mediaType?.startsWith("image/")) return mediaType;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext || "png"}`;
}

/** Bytes as base64, in slices so a large file doesn't overflow the call stack. */
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Base64 (or a data: address) back to bytes. */
export function fromBase64(data: string): ArrayBuffer {
  const b64 = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/**
 * A link in a reply as a path in the space, or null when it points elsewhere
 * (a web address, mail, an anchor). `base` is the folder the text came from
 * ("" for a reply). Lexical only: the core checks every path again.
 */
export function spacePathOf(href: string | undefined, base = ""): string | null {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith("#") || h.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(h)) return null;
  let path = h.split("#")[0].split("?")[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep it as written.
  }
  if (!path) return null;
  const parts: string[] = path.startsWith("/") ? [] : base.split("/").filter(Boolean);
  for (const piece of path.split("/")) {
    if (!piece || piece === ".") continue;
    // A path that climbs out of the space is kept as written: the core refuses it, in words.
    if (piece === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(piece);
  }
  // An absolute path is never a space path.
  if (path.startsWith("/")) return null;
  return parts.join("/") || null;
}
