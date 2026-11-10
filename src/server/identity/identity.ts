import fs from "node:fs";
import path from "node:path";
import { APP_IDENTIFIER, OLD_APP_IDENTIFIER, appDataDir, homeDir } from "../env.ts";
import { lstatOrNull } from "../core/fsx.ts";
import { log } from "../log.ts";

/**
 * The app's identifier was `dev.phaethon.app` until 0.1.2; it is now
 * `io.github.jerynv.phaethon`. Each OS keeps folders under the identifier (app
 * data with the per-vault CLI logins and full-access.json, the cache), so the
 * old ones are moved to the new name once, at launch, before anything opens
 * them. A folder already at the new name is left alone, as is the old one.
 */

/** Pairs `(parent/OLD, dir)` for each dir named by `identifier`, each pair once. */
export function moves(dirs: Iterable<string>, identifier: string): [string, string][] {
  const out: [string, string][] = [];
  for (const dir of dirs) {
    if (path.basename(dir) !== identifier) continue;
    const parent = path.dirname(dir);
    if (parent === dir) continue;
    const pair: [string, string] = [path.join(parent, OLD_APP_IDENTIFIER), dir];
    if (!out.some(([a, b]) => a === pair[0] && b === pair[1])) out.push(pair);
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Moves each old folder to its new name; returns what was done, one line each. */
export function migrate(pairs: [string, string][]): string[] {
  const said: string[] = [];
  for (const [old, next] of pairs) {
    if (!isDir(old)) continue;
    if (exists(next)) {
      said.push(`left ${old} as it is: ${next} already exists`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(next), { recursive: true });
      fs.renameSync(old, next);
      said.push(`moved ${old} to ${next}`);
    } catch (e) {
      said.push(`couldn’t move ${old} to ${next}: ${(e as Error).message}`);
    }
  }
  return said;
}

/** The folders Tauri kept under the identifier on this OS (app data, local data, config, cache, WebKit storage). */
export function appDirs(identifier: string = APP_IDENTIFIER): string[] {
  // A test or development run names its own app data folder; nothing else is touched then.
  if (process.env.PHAETHON_APP_DATA) return [appDataDir()];
  const home = homeDir();
  switch (process.platform) {
    case "darwin":
      return [
        path.join(home, "Library", "Application Support", identifier),
        path.join(home, "Library", "Caches", identifier),
        path.join(home, "Library", "WebKit", identifier),
        path.join(home, "Library", "HTTPStorages", identifier),
      ];
    case "win32": {
      const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      return [path.join(roaming, identifier), path.join(local, identifier)];
    }
    default:
      return [
        path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), identifier),
        path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), identifier),
        path.join(process.env.XDG_CACHE_HOME || path.join(home, ".cache"), identifier),
      ];
  }
}

export function migrateApp(): void {
  for (const line of migrate(moves(appDirs(), APP_IDENTIFIER))) log.info(`identifier: ${line}`);
}

// ---- ~/Steward → ~/Phaethon ---------------------------------------------------

/** True when `dir` holds anything but empty folders. A link counts as content and is never followed. */
export function hasFiles(dir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return true;
  }
  return entries.some((name) => {
    const p = path.join(dir, name);
    try {
      return fs.lstatSync(p).isDirectory() ? hasFiles(p) : true;
    } catch {
      return true;
    }
  });
}

/** Removes a tree of empty folders bottom-up with rmdir only, so no file can ever be deleted. */
function removeEmptyFolders(dir: string): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = path.join(dir, name);
    if (lstatOrNullSafe(p)?.isDirectory()) removeEmptyFolders(p);
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // Not empty (something appeared meanwhile): it stays.
  }
}

function lstatOrNullSafe(p: string): fs.Stats | null {
  try {
    return lstatOrNull(p);
  } catch {
    return null;
  }
}

function renameStateDir(dir: string): void {
  const old = path.join(dir, ".steward");
  const next = path.join(dir, ".phaethon");
  if (isDir(old) && !lstatOrNullSafe(next)) {
    try {
      fs.renameSync(old, next);
    } catch {
      // Left for the next launch.
    }
  }
}

/**
 * The app was called steward: its vault lived in `~/Steward` with state in
 * `.steward/` folders. Moves them once, never overwriting anything. An empty
 * `~/Phaethon` skeleton (a launch before the migration existed) gives way, but
 * it is moved aside rather than deleted and put back if the move fails, so
 * `~/Phaethon` never disappears while the migration is pending (the Rust core
 * deleted it on every launch until `~/Steward` was gone).
 */
export function migrateLegacyRoot(home: string = homeDir()): void {
  const old = path.join(home, "Steward");
  const next = path.join(home, "Phaethon");
  if (isDir(old)) {
    if (isDir(next) && !hasFiles(next)) {
      const aside = path.join(home, `.Phaethon-skeleton-${process.pid}-${Date.now()}`);
      try {
        fs.renameSync(next, aside);
      } catch {
        return;
      }
      try {
        fs.renameSync(old, next);
      } catch {
        try {
          fs.renameSync(aside, next);
        } catch {
          // The skeleton holds no files; ensureVault recreates it.
        }
        return;
      }
      removeEmptyFolders(aside);
    } else if (!lstatOrNullSafe(next)) {
      try {
        fs.renameSync(old, next);
      } catch {
        return;
      }
    }
  }
  let vaults: string[];
  try {
    vaults = fs.readdirSync(next);
  } catch {
    return;
  }
  for (const name of vaults) {
    const vault = path.join(next, name);
    if (!isDir(vault)) continue;
    renameStateDir(vault);
    let spaces: string[] = [];
    try {
      spaces = fs.readdirSync(path.join(vault, "spaces"));
    } catch {
      continue;
    }
    for (const s of spaces) {
      const space = path.join(vault, "spaces", s);
      if (isDir(space)) renameStateDir(space);
    }
  }
}
