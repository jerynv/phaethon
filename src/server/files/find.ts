import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isWithin, realpath } from "../core/fsx.ts";
import { vaultRoot } from "../core/vault.ts";
import { messageOf } from "../rpc/registry.ts";
import * as courseAccess from "../lms/access.ts";
import { COURSES_DIR } from "../lms/store.ts";

/**
 * A second chance for a file a reply names in a way the space doesn't: an
 * absolute path (a CLI agent sees real paths), a path from the vault's root
 * (`spaces/<id>/…`), the space's own name as a prefix, `~`, or just the wrong folder
 * for a name that exists in one place. `resolveLoosely` tries the path as
 * written, then each reading, then a unique file of that name in the space
 * or its visible courses, and otherwise rethrows the first refusal.
 */

const MISSING = /isn’t in this space any more|isn’t there any more|does not exist|isn’t among the courses|only files inside this space|ENOENT/i;
const WALK_MAX = 20_000;
const DEPTH_MAX = 8;
const SKIP = new Set(["node_modules", "target", "dist", "build", "__pycache__"]);

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function real(p: string): string | null {
  try {
    return realpath(p);
  } catch {
    return null;
  }
}

/** Other readings of `p` as a space path, most likely first; never `p` itself. */
export function candidates(spaceId: string, spaceRoot: string, p: string): string[] {
  let t = p.trim().replace(/^file:\/\//i, "");
  if (t.startsWith("~/") || t === "~") t = path.join(os.homedir(), t.slice(1));
  const out: string[] = [];
  const push = (q: string) => {
    const clean = q.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (clean && clean !== p.trim() && !out.includes(clean)) out.push(clean);
  };
  if (path.isAbsolute(t) || /^[a-zA-Z]:[\\/]/.test(t)) {
    const root = real(spaceRoot);
    const abs = real(t) ?? path.resolve(t);
    if (root && isWithin(abs, root)) push(toPosix(path.relative(root, abs)));
    const coursesRoot = real(path.join(vaultRoot(), COURSES_DIR)) ?? path.join(vaultRoot(), COURSES_DIR);
    if (isWithin(abs, coursesRoot)) push(`${COURSES_DIR}/${toPosix(path.relative(coursesRoot, abs))}`);
    return out;
  }
  const rel = toPosix(t).replace(/^(\.\/)+/, "");
  const id = spaceId.toLowerCase();
  // Not `@space/…`: that names another space, and stays refused.
  for (const re of [new RegExp(`^spaces/${escape(id)}/`, "i"), new RegExp(`^${escape(id)}/`, "i"), new RegExp(`^default/spaces/${escape(id)}/`, "i")]) {
    if (re.test(rel)) push(rel.replace(re, ""));
  }
  // "…/courses/<folder>/…" anywhere: the courses live at the vault root.
  const at = rel.toLowerCase().indexOf(`/${COURSES_DIR}/`);
  if (at >= 0) push(rel.slice(at + 1));
  return out;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Files named `name` (any case) under `root`, as paths relative to it, skipping hidden and build folders. */
function namedUnder(root: string, name: string): string[] {
  const want = name.toLowerCase();
  const hits: string[] = [];
  let seen = 0;
  const stack: [string, number][] = [[root, 0]];
  while (stack.length && seen < WALK_MAX) {
    const [dir, depth] = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > WALK_MAX) break;
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < DEPTH_MAX) stack.push([full, depth + 1]);
      } else if (e.isFile() && e.name.toLowerCase() === want) hits.push(toPosix(path.relative(root, full)));
    }
  }
  return hits;
}

/** The one file called `name` in the space or its visible courses, as a space path; null when none or several. */
export function findByName(spaceId: string, spaceRoot: string, name: string): string | null {
  const base = path.basename(name.trim());
  if (!base || !base.includes(".")) return null;
  const hits = namedUnder(spaceRoot, base);
  try {
    const visible = (courseAccess as { visible?: (s: string) => { courses: { state: { folder: string } }[]; dirOf: (c: never) => string | null; walk: (c: never, d: string, s: string, m: number) => [string, string][] } }).visible;
    if (typeof visible === "function") {
      const vis = visible(spaceId);
      for (const c of vis.courses) {
        const dir = vis.dirOf(c as never);
        if (!dir) continue;
        for (const [rel] of vis.walk(c as never, dir, dir, WALK_MAX)) {
          if (path.basename(rel).toLowerCase() === base.toLowerCase()) hits.push(`${COURSES_DIR}/${c.state.folder}/${rel}`);
        }
      }
    }
  } catch {
    // No course layer here: the space alone is searched.
  }
  if (hits.length === 1) return hits[0]!;
  const exact = hits.filter((h) => path.basename(h) === base);
  return exact.length === 1 ? exact[0]! : null;
}

/** `attempt(p)`, else `attempt` on each other reading of `p`, else on the one file of that name; otherwise the first refusal. */
export function resolveLoosely<T>(spaceId: string, spaceRoot: string, p: string, attempt: (q: string) => T): T {
  try {
    return attempt(p);
  } catch (first) {
    // Only a file that isn't where it was named gets a second look; a wall (another space, state, climbing out) stands.
    if (!MISSING.test(messageOf(first))) throw first;
    for (const q of candidates(spaceId, spaceRoot, p)) {
      try {
        return attempt(q);
      } catch {
        // Try the next reading.
      }
    }
    // A path that climbs or names another space is never guessed from its file name.
    const guessable = !/(^|\/)\.\.(\/|$)/.test(p) && !p.trim().startsWith("@");
    const found = guessable ? findByName(spaceId, spaceRoot, p) : null;
    if (found && found !== p.trim()) {
      try {
        return attempt(found);
      } catch {
        // Fall through to the first refusal.
      }
    }
    throw first;
  }
}
