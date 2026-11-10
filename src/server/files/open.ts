import fs from "node:fs";
import path from "node:path";
import { Refusal, messageOf } from "../rpc/registry.ts";
import { host } from "../host.ts";
import { cleanRel, resolveIn } from "../core/resolve.ts";
import { resolveCoursePath } from "../lms/access.ts";

/**
 * Opening a file in its default app, or showing it in the file manager. Only
 * files inside the space (or a `courses/...` path this space may see) can be
 * named; anything that can run a program is only ever shown, never opened.
 * The desktop shell does the launching (`openPath`/`revealPath`).
 */

const RUNNABLE = new Set(
  (
    "app command tool terminal sh bash zsh csh ksh fish scpt scptd applescript workflow action pkg mpkg dmg jar py pyw pl rb php js jse vbs vbe wsf " +
    "wsh ps1 psm1 bat cmd com exe msi scr lnk url webloc inetloc fileloc desktop appimage run bin prefpane saver kext plugin mobileconfig"
  ).split(" "),
);

/** Rust's `Path::extension`, lowercased. */
export function extOf(p: string): string {
  const base = path.basename(p);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

/** A `courses/...` path (first part `courses`, any case) that is lexically clean, as components. */
export function coursesParts(p: string): string[] | undefined {
  try {
    const parts = cleanRel(p);
    return parts[0]?.toLowerCase() === "courses" ? parts : undefined;
  } catch {
    return undefined;
  }
}

/** Where `p` (relative to the space) really is, after every wall. Folders are allowed. */
export function target(spaceId: string, spaceRoot: string, p: string): string {
  const trimmed = p.trim();
  if (!trimmed) throw new Refusal("No file was named.");
  if (trimmed.startsWith("@")) throw new Refusal("Only files in this space can be opened from here.");
  const course = coursesParts(trimmed);
  if (course) {
    try {
      return resolveCoursePath(spaceId, course.join("/"), true);
    } catch {
      throw new Refusal(`“${trimmed}” isn’t among the courses this space can see.`);
    }
  }
  try {
    return resolveIn(spaceRoot, trimmed, true);
  } catch (e) {
    if (messageOf(e).endsWith("does not exist")) throw new Refusal(`“${trimmed}” isn’t in this space any more. It may have been moved or deleted.`);
    throw new Refusal(`“${trimmed}” can’t be opened: only files inside this space can be opened from here.`);
  }
}

/** Runnable by its extension (any case) or, on Unix, an execute bit on a regular file. */
export function isRunnable(p: string): boolean {
  if (RUNNABLE.has(extOf(p))) return true;
  if (process.platform !== "win32") {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (st.mode & 0o111) !== 0) return true;
    } catch {
      // Not there: nothing to run.
    }
  }
  return false;
}

export async function openFile(spaceId: string, spaceRoot: string, p: string, reveal: boolean): Promise<void> {
  const full = target(spaceId, spaceRoot, p);
  if (!reveal && isRunnable(full)) {
    throw new Refusal("This file can run a program, so Phaethon won’t open it. Use Show in Finder to see where it is instead.");
  }
  try {
    await host().call(reveal ? { op: "revealPath", path: full } : { op: "openPath", path: full });
  } catch (e) {
    throw new Refusal(`The file couldn’t be opened: ${messageOf(e)}`);
  }
}

/** Opens (not reveals) a space's folder; a space id has no dots, so it is never an app bundle. */
export async function showSpace(dir: string): Promise<void> {
  let ok = false;
  try {
    ok = fs.statSync(dir).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw new Refusal("This space’s folder isn’t there any more.");
  try {
    await host().call({ op: "openPath", path: dir });
  } catch (e) {
    throw new Refusal(`The space’s folder couldn’t be shown: ${messageOf(e)}`);
  }
}

export async function revealFile(file: string): Promise<void> {
  let ok = false;
  try {
    ok = fs.statSync(file).isFile();
  } catch {
    ok = false;
  }
  if (!ok) throw new Refusal("That file isn’t there any more. It may have been moved or deleted.");
  try {
    await host().call({ op: "revealPath", path: file });
  } catch (e) {
    throw new Refusal(`The file couldn’t be shown: ${messageOf(e)}`);
  }
}
