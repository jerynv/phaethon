import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Refusal, messageOf } from "../rpc/registry.ts";
import { components, isNotFound, isWithin, realpath, writeJsonAtomic } from "../core/fsx.ts";
import { cleanRel, resolveIn } from "../core/resolve.ts";
import { spaceDir, spacesRoot, vaultRoot, vaultStateDir } from "../core/vault.ts";

/**
 * Read-only access grants between spaces. A grant lets one space (`to`) read
 * one folder or file (`path`) of another (`from`); writing is never grantable.
 * "always" grants live in `<vault>/.phaethon/grants.json` (visible, editable,
 * synced); "once" grants live only in memory for the turn that asked. The file
 * is re-read and every entry re-validated on each use; invalid entries are
 * reported, never used, and kept on every write.
 */

export type Scope = "always" | "once";
export type Grant = { id: string; to: string; from: string; path: string; created: string; scope: Scope };
export type GrantView = { id: string; from: string; path: string; created: string; scope: Scope };
export type IncomingGrantView = { id: string; to: string; path: string; created: string; scope: Scope };
export type GrantsView = { grants: GrantView[]; incoming: IncomingGrantView[]; problems: string[] };
export type Loaded = { grants: Grant[]; problems: string[] };

export function grantsFile(): string {
  return path.join(vaultStateDir(), "grants.json");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Every valid saved grant in the vault, with a sentence for each entry that was skipped. */
export function loadGrants(): Loaded {
  let raw: string;
  try {
    raw = fs.readFileSync(grantsFile(), "utf8");
  } catch (e) {
    if (isNotFound(e)) return { grants: [], problems: [] };
    return { grants: [], problems: [`grants.json couldn’t be read, so no folders are shared between spaces: ${messageOf(e)}`] };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    doc = undefined;
  }
  if (!isObject(doc)) {
    return { grants: [], problems: ["grants.json has a typing mistake, so no folders are shared between spaces. Fix it in a text editor or delete it."] };
  }
  if (doc.grants === undefined) return { grants: [], problems: [] };
  if (!Array.isArray(doc.grants)) {
    return { grants: [], problems: ["grants.json isn’t laid out as Phaethon expects, so no folders are shared between spaces."] };
  }
  const out: Loaded = { grants: [], problems: [] };
  const seen = new Set<string>();
  doc.grants.forEach((entry, i) => {
    let g: Grant;
    try {
      g = validate(entry);
    } catch (e) {
      out.problems.push(`Entry ${i + 1} is skipped: ${messageOf(e)}.`);
      return;
    }
    if (seen.has(g.id)) {
      out.problems.push(`Entry ${i + 1} is skipped: its id “${g.id}” appears twice.`);
      return;
    }
    seen.add(g.id);
    out.grants.push(g);
  });
  return out;
}

function validate(entry: unknown): Grant {
  if (!isObject(entry)) throw new Error("it is not an object");
  const s = (k: string): string => {
    const v = entry[k];
    if (typeof v !== "string") throw new Error(`“${k}” is missing or isn’t text`);
    return v;
  };
  const id = s("id");
  if (!id || Buffer.byteLength(id) > 64 || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("its id isn’t valid");
  const to = s("to");
  const from = s("from");
  const scope = entry.scope;
  if (scope === "once") throw new Error("it’s marked “once”, and only grants you chose to keep belong in this file");
  if (scope !== "always") throw new Error("its “scope” should be “always”");
  if (to === from) throw new Error(`it lets ${to} read itself`);
  spaceDir(to);
  spaceDir(from);
  const p = normalizeGrantPath(s("path"));
  const created = typeof entry.created === "string" ? entry.created : "";
  return { id, to, from, path: p, created, scope: "always" };
}

/** A grant path in its saved form: clean, `/`-joined, never the whole space. */
export function normalizeGrantPath(p: string): string {
  const clean = cleanRel(p);
  if (!clean.length) throw new Refusal("it names a whole space, and a grant has to name a folder or file");
  return clean.join("/");
}

/** Component-wise: `calendar` covers `calendar/oct.md`, not `calendar-old`. */
export function covers(grantPath: string, rel: string): boolean {
  const g = components(grantPath).filter((c) => c !== ".");
  if (!g.length) return false;
  const r = components(rel).filter((c) => c !== ".");
  return g.length <= r.length && g.every((c, i) => r[i] === c);
}

function byFromPath(a: Grant, b: Grant): number {
  return cmp(a.from, b.from) || cmp(a.path, b.path);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Saved grants letting `space` read elsewhere, sorted by (from, path). */
export function grantsFor(space: string): Grant[] {
  return loadGrants()
    .grants.filter((g) => g.to === space)
    .sort(byFromPath);
}

export function grantsView(space: string): GrantsView {
  const loaded = loadGrants();
  const mine = loaded.grants.filter((g) => g.to === space).sort(byFromPath);
  const into = loaded.grants.filter((g) => g.from === space).sort((a, b) => cmp(a.to, b.to) || cmp(a.path, b.path));
  return {
    grants: mine.map((g) => ({ id: g.id, from: g.from, path: g.path, created: g.created, scope: g.scope })),
    incoming: into.map((g) => ({ id: g.id, to: g.to, path: g.path, created: g.created, scope: g.scope })),
    problems: loaded.problems,
  };
}

/** The ids of every other valid space, sorted. */
export function otherSpaces(current: string): string[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(spacesRoot());
  } catch {
    return [];
  }
  return names
    .filter((n) => {
      if (n === current) return false;
      try {
        spaceDir(n);
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

/** Checks an access request before the user is asked; returns the normalized path. */
export function checkRequest(current: string, space: string, p: string): string {
  const other = space.startsWith("@") ? space.slice(1) : space;
  if (other === current) throw new Refusal(`${other} is this space; read it directly without asking`);
  let dir: string;
  try {
    dir = spaceDir(other);
  } catch {
    throw new Refusal(`there is no space called "${other}"`);
  }
  const clean = normalizeGrantPath(p);
  resolveIn(dir, clean, true);
  return clean;
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A grant for this turn only; never written. */
export function onceGrant(to: string, from: string, p: string): Grant {
  return { id: randomUUID(), to, from, path: p, created: nowIso(), scope: "once" };
}

/** Parses `@space/rel` (rel is "" with no slash). */
export function parseTarget(p: string): { space: string; rel: string } | null {
  if (!p.startsWith("@")) return null;
  const rest = p.slice(1);
  const i = rest.indexOf("/");
  return i < 0 ? { space: rest, rel: "" } : { space: rest.slice(0, i), rel: rest.slice(i + 1) };
}

/**
 * A cross-space read: `at` is `@space/rel` (or the parsed pair). Needs a
 * grant (saved, or one of `extra`, e.g. this turn's once-grants) from that
 * space covering the path, and the result must stay inside the granted part.
 * Returns the real path and the other space's canonical root.
 */
export function resolveOther(
  current: string,
  at: string | { space: string; rel: string },
  mustExist = true,
  extra: Grant[] = [],
): { real: string; root: string } {
  const t = typeof at === "string" ? (parseTarget(at) ?? { space: "", rel: at }) : at;
  const { space, rel } = t;
  const shown = `@${space}/${rel}`;
  let dir: string;
  try {
    dir = spaceDir(space);
  } catch {
    throw new Refusal(`there is no space called "${space}"`);
  }
  let clean: string;
  try {
    clean = cleanRel(rel).join("/");
  } catch {
    throw new Refusal(`"${shown}" must be a path inside the ${space} space, like "@${space}/notes/today.md"`);
  }
  const grant = [...grantsFor(current), ...extra].find((g) => g.to === current && g.from === space && covers(g.path, clean));
  if (!grant) throw new Refusal(`"${shown}" is in the ${space} space; ask for access with request_access first`);
  let granted: string;
  try {
    granted = resolveIn(dir, grant.path, true);
  } catch {
    throw new Refusal(`the granted path "@${space}/${grant.path}" no longer exists`);
  }
  let real: string;
  try {
    real = resolveIn(dir, clean, mustExist);
  } catch (e) {
    throw new Refusal(messageOf(e).replace("this space", `the ${space} space`));
  }
  if (!isWithin(real, granted)) throw new Refusal(`"${shown}" leads outside the part of the ${space} space you have access to`);
  let root: string;
  try {
    root = realpath(dir);
  } catch (e) {
    throw new Refusal(`space folder unavailable: ${messageOf(e)}`);
  }
  return { real, root };
}

// ---- Writing -------------------------------------------------------------------

function readDoc(): Record<string, unknown> & { grants: unknown[] } {
  let doc: unknown;
  try {
    const text = fs.readFileSync(grantsFile(), "utf8");
    try {
      doc = JSON.parse(text);
    } catch {
      doc = undefined;
    }
    if (!isObject(doc)) {
      throw new Refusal("grants.json has a typing mistake, so Phaethon won’t change it. Fix it in a text editor or delete it, then try again.");
    }
  } catch (e) {
    if (e instanceof Refusal) throw e;
    if (!isNotFound(e)) throw new Refusal(`grants.json couldn’t be read: ${messageOf(e)}`);
    doc = {};
  }
  const o = doc as Record<string, unknown>;
  if (o.grants === undefined) o.grants = [];
  else if (!Array.isArray(o.grants)) {
    throw new Refusal("grants.json isn’t laid out as Phaethon expects, so Phaethon won’t change it. Fix it or delete it, then try again.");
  }
  return o as Record<string, unknown> & { grants: unknown[] };
}

function writeDoc(doc: Record<string, unknown>): void {
  try {
    writeJsonAtomic(grantsFile(), doc);
  } catch (e) {
    throw new Refusal(`grants.json could not be saved: ${messageOf(e)}`);
  }
}

/**
 * Saves an "always" grant, or returns the one already saved for the same
 * (to, from, path). The caller has checked the request (`checkRequest`).
 */
export function addAlways(to: string, from: string, p: string): Grant {
  const clean = normalizeGrantPath(p);
  const existing = loadGrants().grants.find((g) => g.to === to && g.from === from && g.path === clean);
  if (existing) return existing;
  const grant: Grant = { id: randomUUID(), to, from, path: clean, created: nowIso(), scope: "always" };
  const doc = readDoc();
  doc.grants.push({ ...grant });
  writeDoc(doc);
  return grant;
}

const UNDO_FOR_MS = 10 * 60 * 1000;
const revoked: { root: string; id: string; entry: unknown; at: number }[] = [];

function entryId(e: unknown): unknown {
  return isObject(e) ? e.id : undefined;
}

/** Removes every entry with that id (valid or not); the first is kept for Undo for ten minutes. */
export function revokeGrant(id: string): boolean {
  const doc = readDoc();
  const at = doc.grants.findIndex((e) => entryId(e) === id);
  if (at < 0) return false;
  const removed = doc.grants[at];
  doc.grants = doc.grants.filter((e) => entryId(e) !== id);
  writeDoc(doc);
  revoked.push({ root: vaultRoot(), id, entry: removed, at: Date.now() });
  return true;
}

/** Puts back exactly the entry revoked under `id` in this vault, once. */
export function restoreGrant(id: string): Grant {
  const now = Date.now();
  for (let i = revoked.length - 1; i >= 0; i--) if (now - revoked[i]!.at >= UNDO_FOR_MS) revoked.splice(i, 1);
  const i = revoked.findIndex((r) => r.root === vaultRoot() && r.id === id);
  if (i < 0) throw new Refusal("That access can’t be put back any more.");
  const entry = revoked.splice(i, 1)[0]!.entry;
  let grant: Grant;
  try {
    grant = validate(entry);
  } catch (e) {
    throw new Refusal(`That access couldn’t be put back: ${messageOf(e)}.`);
  }
  const doc = readDoc();
  if (!doc.grants.some((e) => entryId(e) === id)) {
    doc.grants.push(entry);
    writeDoc(doc);
  }
  return grant;
}

/** Folders a CLI backend may read (`--add-dir`): granted folders that exist. File grants are left out. */
export function cliDirs(space: string): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = [];
  for (const g of grantsFor(space)) {
    try {
      const real = resolveIn(spaceDir(g.from), g.path, true);
      if (fs.statSync(real).isDirectory()) out.push({ label: `${g.from}/${g.path}`, path: real });
    } catch {
      // Missing or no longer valid: skipped.
    }
  }
  return out;
}
