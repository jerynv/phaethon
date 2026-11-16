import fs from "node:fs";
import path from "node:path";
import { Refusal, messageOf } from "../rpc/registry.ts";
import { cleanRel, resolveIn } from "../core/resolve.ts";
import { lstatOrNull } from "../core/fsx.ts";
import { excludedByName, type FileSort } from "./settings.ts";

/**
 * The Files view's listings: one folder at a time (folders first, sorted and
 * paged in the core so a folder of thousands of files costs one page), a
 * bounded walk of the whole space for a name search or the most recently
 * changed files, and nothing else. Links are never listed or followed,
 * `.phaethon` is never shown, and hidden (dot) files only when asked.
 */

export type FileEntry = {
  name: string;
  /** Relative to the space, "/" separated. */
  path: string;
  dir: boolean;
  size: number;
  modified: number;
  /** A folder's visible entries (links and, unless shown, hidden ones left out). */
  count?: number;
  /** A folder Phaethon's agent may not read (or one inside it). */
  excluded?: boolean;
};

export type FolderPage = { path: string; entries: FileEntry[]; total: number; offset: number };
export type Found = { entries: FileEntry[]; truncated: boolean };

export const PAGE_DEFAULT = 500;
export const PAGE_MAX = 2000;
export const WALK_ENTRIES = 50_000;
const WALK_MS = 2000;
const WALK_DEPTH = 16;

export type ListOptions = { sort: FileSort; desc: boolean; offset: number; limit: number; showHidden: boolean; excluded: string[] };

const isState = (name: string) => name.toLowerCase() === ".phaethon";
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function compareEntries(sort: FileSort, desc: boolean) {
  return (a: FileEntry, b: FileEntry): number => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    let c = 0;
    if (sort === "name") c = collator.compare(a.name, b.name);
    else if (sort === "modified") c = b.modified - a.modified;
    else if (sort === "size" && !a.dir) c = b.size - a.size;
    else if (sort === "type" && !a.dir) c = collator.compare(extOf(a.name), extOf(b.name));
    if (desc) c = -c;
    return c || collator.compare(a.name, b.name);
  };
}

/** Visible children of a folder: its plain files and folders, never links or the state folder. */
function visibleNames(dir: string, showHidden: boolean, atRoot: boolean): fs.Dirent[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => (d.isFile() || d.isDirectory()) && !(atRoot && isState(d.name)) && (showHidden || !d.name.startsWith(".")));
}

function countIn(dir: string, showHidden: boolean): number {
  try {
    return visibleNames(dir, showHidden, false).length;
  } catch {
    return 0;
  }
}

/** The real folder `rel` in the space, refused unless it is a folder inside it (not `.phaethon`). */
export function folderIn(spaceRoot: string, rel: string): { real: string; parts: string[] } {
  let parts: string[];
  let real: string;
  try {
    parts = cleanRel(rel);
    real = resolveIn(spaceRoot, rel, true);
  } catch (e) {
    const m = messageOf(e);
    if (m.endsWith("does not exist")) throw new Refusal(`“${rel}” isn’t in this space any more.`);
    throw new Refusal(`“${rel}” isn’t a folder in this space.`);
  }
  if (!lstatOrNull(real)?.isDirectory()) throw new Refusal(`“${rel}” isn’t a folder in this space.`);
  return { real, parts };
}

export function listFolder(spaceRoot: string, rel: string, o: ListOptions): FolderPage {
  const { real, parts } = folderIn(spaceRoot, rel);
  const prefix = parts.length ? `${parts.join("/")}/` : "";
  let names: fs.Dirent[];
  try {
    names = visibleNames(real, o.showHidden, parts.length === 0);
  } catch (e) {
    throw new Refusal(`“${rel || "This space"}” couldn’t be read: ${messageOf(e)}`);
  }
  const all: FileEntry[] = [];
  for (const d of names) {
    const st = lstatOrNull(path.join(real, d.name));
    if (!st || st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) continue;
    all.push({ name: d.name, path: prefix + d.name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, modified: st.mtimeMs });
  }
  all.sort(compareEntries(o.sort, o.desc));
  const offset = Math.max(0, Math.floor(o.offset) || 0);
  const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(o.limit) || PAGE_DEFAULT));
  const page = all.slice(offset, offset + limit);
  for (const e of page) {
    if (e.dir) e.count = countIn(path.join(real, e.name), o.showHidden);
    if (o.excluded.length && excludedByName(o.excluded, e.path.split("/"))) e.excluded = true;
  }
  return { path: parts.join("/"), entries: page, total: all.length, offset };
}

export type WalkOptions = { query?: string; showHidden: boolean; limit: number; excluded: string[] };

/**
 * A bounded walk of the whole space (at most 50,000 entries, 16 deep, 2 s):
 * with `query`, files and folders whose name contains it (any case), sorted
 * by name; without, the most recently changed files, newest first.
 */
export function walkSpace(spaceRoot: string, o: WalkOptions): Found {
  const root = folderIn(spaceRoot, "").real;
  const q = o.query?.trim().toLowerCase();
  const limit = Math.min(1000, Math.max(1, o.limit));
  const out: FileEntry[] = [];
  let truncated = false;
  let seen = 0;
  const started = Date.now();
  const stack: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: "", depth: 0 }];
  while (stack.length) {
    if (seen >= WALK_ENTRIES || Date.now() - started > WALK_MS) {
      truncated = true;
      break;
    }
    const { abs, rel, depth } = stack.pop()!;
    let names: fs.Dirent[];
    try {
      names = visibleNames(abs, o.showHidden, rel === "");
    } catch {
      continue;
    }
    for (const d of names) {
      if (++seen > WALK_ENTRIES) {
        truncated = true;
        break;
      }
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const childAbs = path.join(abs, d.name);
      const dir = d.isDirectory();
      if (dir && depth < WALK_DEPTH) stack.push({ abs: childAbs, rel: childRel, depth: depth + 1 });
      if (q ? !d.name.toLowerCase().includes(q) : dir) continue;
      const st = lstatOrNull(childAbs);
      if (!st || st.isSymbolicLink()) continue;
      const e: FileEntry = { name: d.name, path: childRel, dir, size: dir ? 0 : st.size, modified: st.mtimeMs };
      if (o.excluded.length && excludedByName(o.excluded, childRel.split("/"))) e.excluded = true;
      out.push(e);
    }
    // Keep memory bounded on a long walk: the recent list only needs its newest `limit`.
    if (!q && out.length > limit * 4) {
      out.sort((a, b) => b.modified - a.modified);
      out.length = limit;
    }
  }
  if (q) {
    out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : collator.compare(a.name, b.name) || collator.compare(a.path, b.path)));
  } else out.sort((a, b) => b.modified - a.modified);
  if (out.length > limit) {
    out.length = limit;
    if (q) truncated = true;
  }
  if (q) for (const e of out) if (e.dir) e.count = countIn(path.join(root, ...e.path.split("/")), o.showHidden);
  return { entries: out, truncated };
}
