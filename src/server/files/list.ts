import fs from "node:fs";
import path from "node:path";

/**
 * The space's own files, for the composer's `@` mentions: relative paths,
 * newest first. Hidden entries (`.phaethon` included) and links are left out,
 * so nothing outside the space folder is listed; deep or huge trees are cut
 * at a depth and a count, which is plenty for picking a file by name.
 */
export type ListedFile = { path: string; modified: number; size: number };

export const LIST_MAX_FILES = 3000;
const MAX_DEPTH = 8;

export function listFiles(root: string): ListedFile[] {
  const out: ListedFile[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > MAX_DEPTH || out.length >= LIST_MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || out.length >= LIST_MAX_FILES) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(path.join(root, p));
          out.push({ path: p, modified: st.mtimeMs, size: st.size });
        } catch {
          // Gone since the listing: skip it.
        }
      }
    }
  };
  walk("", 0);
  return out.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
}
