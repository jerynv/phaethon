import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Refusal, messageOf } from "../rpc/registry.ts";
import { isWithin, lstatOrNull, realpath } from "../core/fsx.ts";
import { isTest } from "../env.ts";
import { folderIn } from "./browse.ts";

/**
 * Changing a space's files from the Files view: rename, move to a folder, new
 * folder, delete. Every path goes through the same walls as reading (inside
 * the space, never `.phaethon`, never through a link out); the item itself
 * may be a file or a folder but never a link, nothing is ever replaced, and
 * the space folder itself can't be renamed, moved or deleted.
 *
 * Delete moves the item to the system trash where the core can do that
 * itself (macOS 15's `/usr/bin/trash`, `gio trash` on Linux), and otherwise
 * deletes it for good; the view asks first and says which it will be.
 */

const CONTROL = /\p{Cc}/u;

/** A file or folder name: one component, no separators or control characters, at most 255 bytes, not `.phaethon`. */
export function checkFileName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new Refusal("Give it a name.");
  if (name === "." || name === "..") throw new Refusal("That name isn’t allowed.");
  if (/[/\\]/.test(name)) throw new Refusal("A name can’t contain / or \\.");
  if (CONTROL.test(name)) throw new Refusal("A name can’t contain line breaks or tabs.");
  if (process.platform === "win32" && /[<>:"|?*]/.test(name)) throw new Refusal('A name can’t contain < > : " | ? or *.');
  if (Buffer.byteLength(name) > 255) throw new Refusal("That name is too long.");
  if (name.toLowerCase() === ".phaethon") throw new Refusal("That name is kept for Phaethon’s own files.");
  return name;
}

/** An item in the space by its path: its folder (real), its name, and its stats. Links and the space itself are refused. */
export function itemIn(spaceRoot: string, rel: string): { parent: string; name: string; abs: string; parts: string[]; st: fs.Stats } {
  const trimmed = String(rel ?? "").trim();
  const pieces = trimmed.split(/[/\\]+/).filter((c) => c && c !== ".");
  if (!pieces.length) throw new Refusal("Choose a file or folder in the space.");
  const name = pieces[pieces.length - 1]!;
  const parentRel = pieces.slice(0, -1).join("/");
  const { real: parent, parts } = folderIn(spaceRoot, parentRel);
  if (name === ".." || name.toLowerCase() === ".phaethon") throw new Refusal(`“${trimmed}” isn’t a file in this space.`);
  const abs = path.join(parent, name);
  const st = lstatOrNull(abs);
  if (!st) throw new Refusal(`“${trimmed}” isn’t in this space any more. It may have been moved or deleted.`);
  if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) throw new Refusal(`“${trimmed}” isn’t a plain file or folder, so Phaethon leaves it alone.`);
  return { parent, name, abs, parts: [...parts, name], st };
}

function relOf(spaceRoot: string, abs: string): string {
  return path.relative(realpath(spaceRoot), abs).split(path.sep).join("/");
}

/** Something (a dangling link included) already has that name, other than `self` (a case-only rename). */
function occupied(p: string, self?: fs.Stats): boolean {
  const st = lstatOrNull(p);
  if (!st) return false;
  return !(self && st.ino === self.ino && st.dev === self.dev);
}

export function renameItem(spaceRoot: string, rel: string, newName: unknown): string {
  const item = itemIn(spaceRoot, rel);
  const name = checkFileName(newName);
  if (name === item.name) return relOf(spaceRoot, item.abs);
  const dest = path.join(item.parent, name);
  if (occupied(dest, item.st)) throw new Refusal(`There’s already something called “${name}” in that folder.`);
  try {
    fs.renameSync(item.abs, dest);
  } catch (e) {
    throw new Refusal(`“${item.name}” couldn’t be renamed: ${messageOf(e)}`);
  }
  return relOf(spaceRoot, dest);
}

export function moveItem(spaceRoot: string, rel: string, toFolder: string): string {
  const item = itemIn(spaceRoot, rel);
  const { real: dest } = folderIn(spaceRoot, String(toFolder ?? ""));
  if (dest === item.parent) return relOf(spaceRoot, item.abs);
  if (item.st.isDirectory() && isWithin(dest, item.abs)) throw new Refusal("A folder can’t be moved into itself.");
  const target = path.join(dest, item.name);
  if (occupied(target)) throw new Refusal(`There’s already something called “${item.name}” in that folder.`);
  try {
    fs.renameSync(item.abs, target);
  } catch (e) {
    throw new Refusal(`“${item.name}” couldn’t be moved: ${messageOf(e)}`);
  }
  return relOf(spaceRoot, target);
}

export function createFolder(spaceRoot: string, parentRel: string, rawName: unknown): string {
  const { real: parent } = folderIn(spaceRoot, String(parentRel ?? ""));
  const name = checkFileName(rawName);
  const dest = path.join(parent, name);
  if (occupied(dest)) throw new Refusal(`There’s already something called “${name}” here.`);
  try {
    fs.mkdirSync(dest);
  } catch (e) {
    throw new Refusal(`The folder couldn’t be made: ${messageOf(e)}`);
  }
  return relOf(spaceRoot, dest);
}

type Trasher = { kind: "command"; file: string; args: (p: string) => string[] } | { kind: "dir"; dir: string };

/** How this core can move something to the trash, or null when it can only delete. */
export function trasher(): Trasher | null {
  // End-to-end tests point this at a folder so nothing lands in the real Trash.
  const testDir = process.env.PHAETHON_TRASH_DIR;
  if (testDir) return { kind: "dir", dir: testDir };
  if (isTest()) return null;
  if (process.platform === "darwin" && lstatOrNull("/usr/bin/trash")?.isFile()) return { kind: "command", file: "/usr/bin/trash", args: (p) => [p] };
  if (process.platform === "linux") {
    for (const g of ["/usr/bin/gio", "/bin/gio"]) if (lstatOrNull(g)?.isFile()) return { kind: "command", file: g, args: (p) => ["trash", "--", p] };
  }
  return null;
}

export const canTrash = () => trasher() !== null;

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split("\n").pop() || "it failed"));
      else resolve();
    });
  });
}

/** Moves the item to the trash (true) or, where there's none, deletes it for good (false). */
export async function deleteItem(spaceRoot: string, rel: string): Promise<{ trashed: boolean }> {
  const item = itemIn(spaceRoot, rel);
  const t = trasher();
  if (t?.kind === "command") {
    try {
      await run(t.file, t.args(item.abs));
    } catch (e) {
      throw new Refusal(`“${item.name}” couldn’t be moved to the Trash: ${messageOf(e)}`);
    }
    if (lstatOrNull(item.abs)) throw new Refusal(`“${item.name}” couldn’t be moved to the Trash.`);
    return { trashed: true };
  }
  if (t?.kind === "dir") {
    fs.mkdirSync(t.dir, { recursive: true });
    let dest = path.join(t.dir, item.name);
    for (let n = 2; lstatOrNull(dest); n++) dest = path.join(t.dir, `${item.name} ${n}`);
    fs.renameSync(item.abs, dest);
    return { trashed: true };
  }
  try {
    fs.rmSync(item.abs, { recursive: true, force: false });
  } catch (e) {
    throw new Refusal(`“${item.name}” couldn’t be deleted: ${messageOf(e)}`);
  }
  return { trashed: false };
}
