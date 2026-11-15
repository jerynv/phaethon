import { spacePathOf } from "../../viewer/kinds.ts";

/**
 * What a link in a reply points at. Web and mail links open in the browser;
 * anything else that names a file is a path inside the space and opens in the
 * in-app viewer (a relative link would otherwise resolve to `app://…`, which
 * the desktop shell refuses).
 */
export type LinkTarget = { kind: "external"; url: string } | { kind: "file"; path: string } | { kind: "anchor" } | { kind: "none" };

const EXTERNAL = /^(https?:|mailto:)/i;
/** An absolute path on this computer (a rooted link like /notes/x.md means the space's root instead). */
const REAL_PATH = /^(file:\/\/|~\/|\/(Users|home|private|var|tmp|mnt|Volumes|opt|srv)\/|[a-zA-Z]:[\\/])/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function linkTarget(href: string | undefined | null): LinkTarget {
  const raw = (href ?? "").trim();
  if (!raw) return { kind: "none" };
  if (raw.startsWith("#")) return { kind: "anchor" };
  if (EXTERNAL.test(raw)) return { kind: "external", url: raw };
  // A real path (a coding agent writes what it sees) goes to the core as written; it places it in the space.
  if (REAL_PATH.test(raw)) return { kind: "file", path: raw.replace(/^file:\/\//i, "") };
  // app://phaethon/notes/x.md (a relative link the page already resolved) keeps only its path.
  const app = /^app:\/\/[^/]*\/(.*)$/i.exec(raw);
  const rel = app ? app[1]! : raw.replace(/^\/+/, "");
  if (SCHEME.test(rel) || rel.startsWith("//")) return { kind: "none" };
  const path = spacePathOf(rel);
  if (!path || path.split("/")[0] === "..") return { kind: "none" };
  return { kind: "file", path };
}

/** File extensions that make inline code like `notes/week-6.md` read as a file in the space. */
const FILE_EXT = /\.(md|markdown|txt|pdf|docx?|pptx?|xlsx?|csv|tsv|json|ya?ml|tex|bib|png|jpe?g|gif|webp|svg|html?|py|ts|tsx|js|jsx|c|cpp|h|java|rs|go|rb|ipynb)$/i;

/** True for inline code that is a plain relative path to a file (no spaces, no scheme, a known extension). */
export function looksLikeFilePath(text: string): boolean {
  const t = text.trim();
  if (t.length < 3 || t.length > 240 || /\s/.test(t) || SCHEME.test(t)) return false;
  if (t.split("/").some((p, i) => p === ".." || (p === "" && i > 0))) return false;
  return FILE_EXT.test(t);
}

/** The last segment of a path, for chips. */
export function baseName(path: string): string {
  const clean = path.replace(/\/+$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1) || clean;
}
