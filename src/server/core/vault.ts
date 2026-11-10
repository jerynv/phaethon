import fs from "node:fs";
import path from "node:path";
import { appDataDir, homeDir } from "../env.ts";
import { Refusal } from "../rpc/registry.ts";
import { byteLength, lstatOrNull, realpath } from "./fsx.ts";

/**
 * The vault: one person's folder, `~/Phaethon/default`. Only one vault is used
 * today. Space ids from the renderer become folders only through `spaceDir`.
 */

export const DEFAULT_VAULT = "default";
export const DEFAULT_SPACES = ["school", "work"] as const;

export function phaethonRoot(): string {
  return path.join(homeDir(), "Phaethon");
}

/** `<home>/Phaethon/default`, the plain join (not canonicalized), as the Rust core used. */
export function vaultRoot(): string {
  return path.join(phaethonRoot(), DEFAULT_VAULT);
}

/** Namespaces per-vault state kept outside the vault (keychain accounts, CLI homes). */
export function vaultName(): string {
  return path.basename(vaultRoot()) || DEFAULT_VAULT;
}

/** `<vault>/.phaethon`, the vault's own state. */
export function vaultStateDir(): string {
  return path.join(vaultRoot(), ".phaethon");
}

export function spacesRoot(): string {
  return path.join(vaultRoot(), "spaces");
}

export function isValidSpaceId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(id) && byteLength(id) <= 64;
}

/**
 * The canonical folder of a space, refusing anything that isn't a real folder
 * directly inside `<vault>/spaces` (symlinks included, even to a sibling).
 */
export function spaceDir(id: unknown): string {
  if (!isValidSpaceId(id)) throw new Refusal(`"${String(id)}" is not a valid space name`);
  let spaces: string;
  try {
    spaces = realpath(spacesRoot());
  } catch (e) {
    throw new Refusal(`spaces folder unavailable: ${(e as Error).message}`);
  }
  const candidate = path.join(spaces, id);
  const link = lstatOrNull(candidate);
  if (link?.isSymbolicLink()) throw new Refusal(`space "${id}" is not a folder inside this vault`);
  let dir: string;
  try {
    dir = realpath(candidate);
  } catch {
    throw new Refusal(`space "${id}" does not exist in this vault`);
  }
  if (path.dirname(dir) !== spaces || !fs.statSync(dir).isDirectory()) throw new Refusal(`space "${id}" is not a folder inside this vault`);
  return dir;
}

/** `<space>/.phaethon`. */
export function spaceStateDir(id: string): string {
  return path.join(spaceDir(id), ".phaethon");
}

/** Creates the vault skeleton; never writes a file or overwrites anything. */
export function ensureVault(): void {
  const root = vaultRoot();
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills"), { recursive: true });
  for (const space of DEFAULT_SPACES) fs.mkdirSync(path.join(root, "spaces", space), { recursive: true });
}

/** App-data files (Tauri's folder for this app, kept so existing files are found). */
export const appFiles = {
  dir: () => appDataDir(),
  claudeConfigRoot: () => path.join(appDataDir(), "claude-config"),
  fullAccess: () => path.join(appDataDir(), "full-access.json"),
  workspaces: () => path.join(appDataDir(), "workspaces.json"),
  modelPictures: () => path.join(appDataDir(), "model-pictures.json"),
};
