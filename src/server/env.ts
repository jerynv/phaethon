import os from "node:os";
import path from "node:path";
import { CHANNEL, IDENTITY } from "#shared/channel.ts";

/**
 * Where things live on this machine. Every path the core uses starts here, so
 * tests can point the whole core at a temporary home with environment
 * variables instead of touching the real one.
 *
 * - PHAETHON_HOME: stands in for the user's home folder (vault at `<home>/Phaethon`).
 * - PHAETHON_APP_DATA: stands in for the app data folder.
 */

/** `io.github.jerynv.phaethon`, or its `.dev` sibling in a dev build. */
export const APP_IDENTIFIER = IDENTITY.appIdentifier;
/** A dev build keeps its own state and never adopts the release's old folders or keychain entries. */
export const isDevChannel = () => CHANNEL === "dev";
/** The identifier before the rename; its folders are moved over once. */
export const OLD_APP_IDENTIFIER = "dev.phaethon.app";

export function homeDir(): string {
  return process.env.PHAETHON_HOME || os.homedir();
}

/**
 * Tauri's app data folder for an identifier, computed exactly as Tauri did, so
 * files the Rust app wrote (full-access.json, workspaces.json, per-vault CLI
 * logins) are still found.
 */
export function tauriDataDir(identifier: string = APP_IDENTIFIER): string {
  if (process.env.PHAETHON_APP_DATA && identifier === APP_IDENTIFIER) return process.env.PHAETHON_APP_DATA;
  const home = homeDir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", identifier);
    case "win32":
      return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), identifier);
    default:
      return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), identifier);
  }
}

export function appDataDir(): string {
  return tauriDataDir(APP_IDENTIFIER);
}

export const isTest = () => process.env.PHAETHON_TEST === "1";
