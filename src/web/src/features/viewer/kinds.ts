/** Mirrors `ViewKind` from `file_view`. */
export type ViewKind = "markdown" | "tex" | "text" | "pdf" | "image" | "docx" | "spreadsheet" | "slides" | "audio" | "video" | "other";

/** Mirrors `FileView` from `file_view`. */
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

export const isByteKind = (kind: ViewKind) => ["pdf", "image", "docx", "spreadsheet", "slides", "audio", "video"].includes(kind);

/** The most the viewer fetches to show in place. */
export const previewByteLimit = (kind: ViewKind) =>
  (kind === "image" ? 20 : ["docx", "spreadsheet", "slides"].includes(kind) ? 10 : 40) * 1024 * 1024;

/** The media type of an image by its name, for a blob. */
export function imageType(name: string, mediaType?: string): string {
  if (mediaType?.startsWith("image/")) return mediaType;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext || "png"}`;
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
  if (!path || path.startsWith("/")) return null;
  const parts: string[] = base.split("/").filter(Boolean);
  for (const piece of path.split("/")) {
    if (!piece || piece === ".") continue;
    if (piece === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(piece);
  }
  return parts.join("/") || null;
}

/** shiki's language id for a file, by its extension. */
export function languageOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", py: "python", rb: "ruby",
    rs: "rust", go: "go", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
    php: "php", sh: "bash", bash: "bash", zsh: "bash", sql: "sql", r: "r", lua: "lua", json: "json", jsonl: "json",
    yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", xml: "xml", html: "html", htm: "html", css: "css", tex: "latex", bib: "bibtex",
    md: "markdown",
  };
  return map[ext] ?? "text";
}
