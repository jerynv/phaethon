import fs from "node:fs";
import path from "node:path";
import { Refusal, messageOf } from "../rpc/registry.ts";
import { components, isWithin, realpath } from "../core/fsx.ts";
import { appFiles, isValidSpaceId, spaceDir, vaultRoot } from "../core/vault.ts";
import { persistedPath } from "../fullaccess/fullaccess.ts";

/**
 * Device-local, explicitly chosen CLI working folders, in
 * `<app_data>/workspaces.json` (never in the vault: vault files never grant an
 * external path). A binding replaces only the CLI's working directory. A moved,
 * replaced or symlink-swapped folder is unavailable and never falls back to
 * another one. Device and inode numbers are kept as exact integers (they can
 * exceed 2^53).
 */

const MAX_MAP_BYTES = 1024 * 1024;
let nextTemp = 1;

export type WorkspaceView = { path: string; kind: "folder" | "managed"; available: boolean };
type Identity = { device: bigint; inode: bigint };
type Binding = { path: string; identity: Identity | null };
type Bindings = Map<string, Binding>;

/** Where the map lives (null: nowhere, the feature is off) and which vault it is for. */
export type Where = { file: string | null; root: string };

export function defaultWhere(): Where {
  return { file: appFiles.workspaces(), root: vaultRoot() };
}

const fail = (m: string) => new Refusal(m);

function canonicalRoot(root: string): string {
  try {
    return persistedPath(realpath(root));
  } catch (e) {
    throw fail(`The vault folder is unavailable: ${messageOf(e)}`);
  }
}

function keyOf(root: string, space: string): string {
  if (!isValidSpaceId(space)) throw fail("That is not a valid space id.");
  const r = canonicalRoot(root);
  if (r.includes("\n")) throw fail("The vault path cannot contain a newline.");
  return `${r}\n${space}`;
}

function existsFollowing(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The map's real location; refused unless absolute, without `..`, and outside the vault. */
function mapLocation(file: string, root: string): string {
  if (!path.isAbsolute(file) || !path.basename(file) || components(file).includes("..")) {
    throw fail("The workspace settings path must be an absolute file path.");
  }
  let parent = path.dirname(file);
  const missing: string[] = [];
  while (!existsFollowing(parent)) {
    const up = path.dirname(parent);
    if (up === parent) throw fail("The workspace settings folder is unavailable.");
    missing.push(path.basename(parent));
    parent = up;
  }
  let real: string;
  try {
    real = realpath(parent);
  } catch (e) {
    throw fail(`The workspace settings folder is unavailable: ${messageOf(e)}`);
  }
  if (!fs.statSync(real).isDirectory()) throw fail("The workspace settings folder is not a directory.");
  for (const c of missing.reverse()) real = path.join(real, c);
  real = persistedPath(real);
  if (isWithin(real, canonicalRoot(root))) throw fail("Workspace bindings must be stored outside the synced vault.");
  return path.join(real, path.basename(file));
}

type Ctx = { source: string };

function parseMap(text: string): Bindings {
  let doc: unknown;
  try {
    // Exact integers from the source text: inode numbers can exceed 2^53.
    doc = JSON.parse(text, (_key, value, ctx?: Ctx) => (typeof value === "number" && ctx ? { $int: ctx.source } : value));
  } catch {
    doc = undefined;
  }
  const invalid = () => fail("Workspace settings are invalid. Existing bindings were left unchanged.");
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw invalid();
  const out: Bindings = new Map();
  const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && !("$int" in (v as object));
  const u64 = (v: unknown): bigint => {
    const src = (v as { $int?: unknown } | null)?.$int;
    if (typeof src !== "string" || !/^\d+$/.test(src)) throw invalid();
    const n = BigInt(src);
    if (n > 18446744073709551615n) throw invalid();
    return n;
  };
  for (const [key, raw] of Object.entries(doc as Record<string, unknown>)) {
    if (!isPlain(raw) || Object.keys(raw).some((k) => k !== "path" && k !== "identity") || typeof raw.path !== "string") throw invalid();
    let identity: Identity | null = null;
    if (raw.identity !== undefined && raw.identity !== null) {
      const id = raw.identity;
      if (!isPlain(id) || Object.keys(id).some((k) => k !== "device" && k !== "inode") || !("device" in id) || !("inode" in id)) throw invalid();
      identity = { device: u64(id.device), inode: u64(id.inode) };
    }
    out.set(key, { path: raw.path, identity });
  }
  for (const [key, binding] of out) {
    const nl = key.indexOf("\n");
    if (nl < 0) throw fail("Workspace settings contain an invalid key.");
    const root = key.slice(0, nl);
    const space = key.slice(nl + 1);
    if (!path.isAbsolute(root) || !isValidSpaceId(space) || !path.isAbsolute(binding.path)) throw fail("Workspace settings contain an invalid binding.");
    if (process.platform !== "win32" && !binding.identity) throw fail("Workspace settings are missing a folder identity.");
  }
  return out;
}

function readMap(where: Where): Bindings {
  if (!where.file) return new Map();
  const file = mapLocation(where.file, where.root);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw fail(`Workspace settings could not be read: ${messageOf(e)}`);
  }
  if (!st.isFile() || st.isSymbolicLink()) throw fail("Workspace settings must be a regular file.");
  if (st.size > MAX_MAP_BYTES) throw fail("Workspace settings exceed the 1 MiB limit.");
  let bytes: Buffer;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const buf = Buffer.alloc(MAX_MAP_BYTES + 1);
      let n = 0;
      for (;;) {
        const r = fs.readSync(fd, buf, n, buf.length - n, null);
        if (r === 0) break;
        n += r;
        if (n >= buf.length) break;
      }
      bytes = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    throw fail(`Workspace settings could not be read: ${messageOf(e)}`);
  }
  if (bytes.length > MAX_MAP_BYTES) throw fail("Workspace settings exceed the 1 MiB limit.");
  return parseMap(bytes.toString("utf8"));
}

type Raw = { rawJSON(text: string): unknown };

function serialize(all: Bindings): string {
  const raw = (JSON as unknown as Raw).rawJSON;
  const keys = [...all.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  const obj: Record<string, unknown> = {};
  for (const k of keys) {
    const b = all.get(k)!;
    obj[k] = {
      path: b.path,
      identity: b.identity ? { device: raw(b.identity.device.toString()), inode: raw(b.identity.inode.toString()) } : null,
    };
  }
  return JSON.stringify(obj, null, 2);
}

function writeMap(where: Where & { file: string }, all: Bindings): void {
  const file = mapLocation(where.file, where.root);
  const text = serialize(all);
  if (Buffer.byteLength(text) > MAX_MAP_BYTES) throw fail("Workspace settings exceed the 1 MiB limit.");
  const parent = path.dirname(file);
  const temp = path.join(parent, `.workspaces-${process.pid}-${nextTemp++}.tmp`);
  try {
    fs.mkdirSync(parent, { recursive: true });
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (e) {
    fs.rmSync(temp, { force: true });
    throw fail(`Workspace settings could not be saved: ${messageOf(e)}`);
  }
}

function identityOf(st: fs.BigIntStats): Identity | null {
  return process.platform === "win32" ? null : { device: st.dev, inode: st.ino };
}

function sameIdentity(a: Identity | null, b: Identity | null): boolean {
  if (!a || !b) return a === b;
  return a.device === b.device && a.inode === b.inode;
}

/** Validates a chosen folder; returns its canonical path and identity. */
function folder(selected: string, where: Where): { real: string; identity: Identity | null } {
  if (!path.isAbsolute(selected)) throw fail("Choose an absolute workspace folder.");
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(selected, { bigint: true });
  } catch (e) {
    throw fail(`The workspace folder is unavailable: ${messageOf(e)}`);
  }
  if (before.isSymbolicLink() || !before.isDirectory()) throw fail("Choose a real folder, not a file or symbolic link.");
  let real: string;
  try {
    real = persistedPath(realpath(selected));
  } catch (e) {
    throw fail(`The workspace folder is unavailable: ${messageOf(e)}`);
  }
  const vault = canonicalRoot(where.root);
  if (path.dirname(real) === real || isWithin(real, vault) || components(real).includes(".phaethon")) {
    throw fail("Choose a project folder outside Phaethon's managed vault and state folders.");
  }
  if (where.file) {
    const settings = mapLocation(where.file, where.root);
    if (isWithin(real, path.dirname(settings))) throw fail("Phaethon's app-data folder cannot be a workspace.");
  }
  let after: fs.BigIntStats;
  try {
    after = fs.statSync(real, { bigint: true });
  } catch (e) {
    throw fail(`The workspace folder is unavailable: ${messageOf(e)}`);
  }
  if (!sameIdentity(identityOf(before), identityOf(after))) {
    throw fail("The workspace folder changed while it was being selected. Choose it again.");
  }
  return { real, identity: identityOf(after) };
}

function boundFolder(binding: Binding, where: Where): string {
  const { real, identity } = folder(binding.path, where);
  if (real !== binding.path || !sameIdentity(identity, binding.identity)) {
    throw fail("The chosen workspace folder was replaced or moved. Choose it again.");
  }
  return real;
}

function managed(managedDir: string): WorkspaceView {
  let available = false;
  try {
    const st = fs.lstatSync(managedDir);
    available = st.isDirectory() && !st.isSymbolicLink();
  } catch {
    available = false;
  }
  return { path: managedDir, kind: "managed", available };
}

export function getWorkspace(space: string, managedDir: string, where: Where = defaultWhere()): WorkspaceView {
  const key = keyOf(where.root, space);
  const binding = readMap(where).get(key);
  if (!binding) return managed(managedDir);
  let available = true;
  try {
    boundFolder(binding, where);
  } catch {
    available = false;
  }
  return { path: binding.path, kind: "folder", available };
}

export function bindWorkspace(space: string, selected: string, where: Where = defaultWhere()): WorkspaceView {
  if (!where.file) throw fail("Phaethon's app-data folder is unavailable.");
  const key = keyOf(where.root, space);
  const all = readMap(where);
  const { real, identity } = folder(selected, where);
  all.set(key, { path: real, identity });
  writeMap({ ...where, file: where.file }, all);
  return { path: real, kind: "folder", available: true };
}

export function clearWorkspace(space: string, managedDir: string, where: Where = defaultWhere()): WorkspaceView {
  if (!where.file) throw fail("Phaethon's app-data folder is unavailable.");
  const key = keyOf(where.root, space);
  const all = readMap(where);
  if (all.delete(key)) writeMap({ ...where, file: where.file }, all);
  return managed(managedDir);
}

export function resolveWorkspace(space: string, managedDir: string, where: Where = defaultWhere()): string {
  const key = keyOf(where.root, space);
  const binding = readMap(where).get(key);
  if (binding) return boundFolder(binding, where);
  if (managed(managedDir).available) {
    try {
      return realpath(managedDir);
    } catch (e) {
      throw fail(`The managed workspace is unavailable: ${messageOf(e)}`);
    }
  }
  throw fail("The managed workspace folder is unavailable.");
}

/** The CLI's working folder for `space`: the bound folder, or null for the space folder itself. Throws when a binding can't be used. */
export function workingDirFor(space: string): string | null {
  const dir = spaceDir(space);
  const resolved = resolveWorkspace(space, dir);
  return resolved === dir ? null : resolved;
}
