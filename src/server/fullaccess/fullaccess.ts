import fs from "node:fs";
import path from "node:path";
import { Refusal, messageOf } from "../rpc/registry.ts";
import { prettyJson, realpath } from "../core/fsx.ts";
import { appFiles, vaultRoot } from "../core/vault.ts";

/**
 * Full access: a space whose CLI backend runs with no walls. Which spaces have
 * it is kept on this computer only, in app data (`full-access.json`), never in
 * the vault, so syncing can't turn it on elsewhere. Keyed by the vault's real
 * path and the space id. Phaethon's own loop is unaffected.
 */

/**
 * How a path the Rust core persisted looked: its `canonicalize`, which on
 * Windows is a verbatim `\\?\C:\…` (or `\\?\UNC\…`) path. Used for every
 * persisted or compared key so existing entries keep matching.
 */
export function persistedPath(p: string): string {
  if (process.platform !== "win32" || p.startsWith("\\\\?\\")) return p;
  if (p.startsWith("\\\\")) return `\\\\?\\UNC\\${p.slice(2)}`;
  return `\\\\?\\${p}`;
}

function file(): string {
  return appFiles.fullAccess();
}

function read(): Set<string> {
  try {
    const v = JSON.parse(fs.readFileSync(file(), "utf8")) as unknown;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return new Set();
    return new Set(v as string[]);
  } catch {
    return new Set();
  }
}

function keyOf(space: string): string {
  let root: string;
  try {
    root = persistedPath(realpath(vaultRoot()));
  } catch {
    root = vaultRoot();
  }
  return `${root}\n${space}`;
}

export function isFullAccess(space: string): boolean {
  return read().has(keyOf(space));
}

/** Ids of this vault's spaces with full access (not checked against existing spaces). */
export function fullAccessList(): string[] {
  const prefix = keyOf("");
  return sortBytes([...read()])
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

function sortBytes(items: string[]): string[] {
  return items.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
}

export function setFullAccess(space: string, on: boolean): void {
  const all = read();
  const k = keyOf(space);
  if (on) all.add(k);
  else all.delete(k);
  const f = file();
  const tmp = path.join(path.dirname(f), `full-access.${process.pid}.tmp`);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, prettyJson(sortBytes([...all])));
    fs.renameSync(tmp, f);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Refusal(`Full access couldn’t be saved: ${messageOf(e)}`);
  }
}
