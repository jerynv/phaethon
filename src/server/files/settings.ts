import path from "node:path";
import { Refusal } from "../rpc/registry.ts";
import { cleanRel, resolveIn } from "../core/resolve.ts";
import { isWithin, lstatOrNull, realpath } from "../core/fsx.ts";
import { spaceDir } from "../core/vault.ts";
import { readSpaceMeta, updateSpaceMeta } from "../spaces/meta.ts";

/**
 * A space's Files settings, kept as `files` in `<space>/.phaethon/space.json`
 * (the file may be edited by hand and may sync, so every field is checked on
 * the way in and a bad one falls back to its default):
 *
 *   "files": { "showHidden": false, "sort": "name", "excluded": ["private", "taxes/2025"] }
 *
 * `excluded` are folders Phaethon's own agent may not read or write: its file
 * tools refuse any path inside one (checked by name and by real path, so a
 * link inside the space can't reach one either), listings leave them out and
 * searches skip them. The coding agents read the folder through their own
 * tools, so this setting doesn't reach them.
 */

export type FileSort = "name" | "modified" | "size" | "type";
export const FILE_SORTS: readonly FileSort[] = ["name", "modified", "size", "type"];
export type FilesSettings = { showHidden: boolean; sort: FileSort; excluded: string[] };

export const MAX_EXCLUDED = 50;
const MAX_EXCLUDED_CHARS = 512;
const KEY = "files";

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** A folder path as saved: components joined with "/", or undefined when it isn't a folder path inside the space. */
export function normalFolder(rel: unknown): string | undefined {
  if (typeof rel !== "string" || !rel.trim() || rel.length > MAX_EXCLUDED_CHARS) return undefined;
  try {
    const parts = cleanRel(rel.trim().replace(/\\/g, "/"));
    return parts.length ? parts.join("/") : undefined;
  } catch {
    return undefined;
  }
}

function excludedOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const r of raw) {
    const f = normalFolder(r);
    if (f && !out.some((o) => o.toLowerCase() === f.toLowerCase())) out.push(f);
    if (out.length >= MAX_EXCLUDED) break;
  }
  return out;
}

export function readFilesSettings(space: string): FilesSettings {
  let raw: unknown;
  try {
    raw = readSpaceMeta(space).raw?.[KEY];
  } catch {
    raw = undefined;
  }
  const o = isObject(raw) ? raw : {};
  return {
    showHidden: o.showHidden === true,
    sort: typeof o.sort === "string" && (FILE_SORTS as readonly string[]).includes(o.sort) ? (o.sort as FileSort) : "name",
    excluded: excludedOf(o.excluded),
  };
}

export type FilesPatch = { showHidden?: boolean | null; sort?: string | null; excluded?: string[] | null };

/** Changes the given fields; an excluded folder must be a real folder in the space (not a link) when it is added. */
export function updateFilesSettings(space: string, patch: FilesPatch): FilesSettings {
  const cur = readFilesSettings(space);
  const next: FilesSettings = { ...cur };
  if (typeof patch.showHidden === "boolean") next.showHidden = patch.showHidden;
  if (typeof patch.sort === "string") {
    if (!(FILE_SORTS as readonly string[]).includes(patch.sort)) throw new Refusal("Sort by name, modified, size or type.");
    next.sort = patch.sort as FileSort;
  }
  if (Array.isArray(patch.excluded)) {
    const root = spaceDir(space);
    const list: string[] = [];
    for (const r of patch.excluded) {
      const f = normalFolder(r);
      if (!f) throw new Refusal(`“${String(r)}” isn’t a folder in this space.`);
      if (list.some((o) => o.toLowerCase() === f.toLowerCase())) continue;
      const known = cur.excluded.some((o) => o.toLowerCase() === f.toLowerCase());
      if (!known) {
        let real: string;
        try {
          real = resolveIn(root, f, true);
        } catch {
          throw new Refusal(`“${f}” isn’t a folder in this space.`);
        }
        const st = lstatOrNull(path.join(realpath(root), ...f.split("/")));
        if (!st?.isDirectory() || !lstatOrNull(real)?.isDirectory()) throw new Refusal(`“${f}” isn’t a folder in this space.`);
      }
      list.push(f);
    }
    if (list.length > MAX_EXCLUDED) throw new Refusal(`At most ${MAX_EXCLUDED} folders can be kept from Phaethon’s agent.`);
    next.excluded = list;
  }
  updateSpaceMeta(space, (meta) => {
    const was = isObject(meta[KEY]) ? (meta[KEY] as Record<string, unknown>) : {};
    meta[KEY] = { ...was, showHidden: next.showHidden, sort: next.sort, excluded: next.excluded };
  }, { unreadable: "the Files settings weren’t changed", failed: "The Files settings couldn’t be saved" });
  return next;
}

/** The excluded folder `parts` (components inside the space) is in, by name, ignoring case. */
export function excludedByName(excluded: string[], parts: string[]): string | undefined {
  const lower = parts.map((p) => p.toLowerCase());
  return excluded.find((f) => {
    const fp = f.toLowerCase().split("/");
    return fp.length <= lower.length && fp.every((c, i) => c === lower[i]);
  });
}

/** What a space keeps from the agent, resolved once: names, and the real folders that exist. */
export type Exclusions = { excluded: string[]; reals: { folder: string; real: string }[] };

export function exclusionsFor(space: string, root: string): Exclusions {
  const excluded = readFilesSettings(space).excluded;
  const reals: Exclusions["reals"] = [];
  if (excluded.length) {
    let realRoot: string;
    try {
      realRoot = realpath(root);
    } catch {
      return { excluded, reals };
    }
    for (const folder of excluded) {
      try {
        const real = realpath(path.join(realRoot, ...folder.split("/")));
        if (isWithin(real, realRoot)) reals.push({ folder, real });
      } catch {
        // Not there now: still refused by name.
      }
    }
  }
  return { excluded, reals };
}

/** The excluded folder that `parts` (by name) or `real` (where it really is) falls in. */
export function excludedFolder(ex: Exclusions, parts: string[], real?: string): string | undefined {
  if (!ex.excluded.length) return undefined;
  const byName = excludedByName(ex.excluded, parts);
  if (byName) return byName;
  if (real) return ex.reals.find((r) => isWithin(real, r.real))?.folder;
  return undefined;
}

/** The model-facing refusal for a path in an excluded folder. Keep it exact; tests match on it. */
export function excludedRefusal(shown: string, folder: string): Refusal {
  return new Refusal(
    `"${shown}" is inside "${folder}/", a folder this space's settings keep from Phaethon's agent (Settings › Spaces › Files). Don't try to reach it another way; tell the user it's excluded if they ask about it`,
  );
}

/** Throws the refusal when `parts`/`real` fall in a folder space `space` keeps from the agent. */
export function guardExcluded(space: string, root: string, shown: string, parts: string[], real?: string): void {
  const ex = exclusionsFor(space, root);
  const folder = excludedFolder(ex, parts, real);
  if (folder) throw excludedRefusal(shown, folder);
}
