import fs from "node:fs";
import path from "node:path";
import { keychainDelete, keychainGet, keychainSet, lmsLegacySpaceAccount, lmsVaultAccount } from "../core/secrets.ts";
import { spaceDir, vaultRoot } from "../core/vault.ts";
import { allowAll, courseKey, spaces } from "./access.ts";
import { dirIn, segment } from "./names.ts";
import { markSignedIn } from "./service.ts";
import { COURSES_DIR, FILE, folders, getConn, GRADES_FILE, load, loadGrades, save, saveGrades, STATE_DIR, type Store } from "./store.ts";

/**
 * Course sites used to belong to a space (`<space>/.phaethon/lms.json`,
 * `<space>/courses/`, keychain `{vault}/space/{space}/lms/{id}`); now they
 * belong to the vault. This moves an older vault over once, at startup, and is
 * safe to run again: nothing is ever copied or deleted that wasn't moved.
 * The report never holds a secret.
 */

export interface Keys {
  spaceGet(space: string, connection: string): string | null;
  spaceClear(space: string, connection: string): void;
  vaultGet(connection: string): string | null;
  vaultSet(connection: string, secret: string): void;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const keychainKeys: Keys = {
  spaceGet: (space, connection) => keychainGet(lmsLegacySpaceAccount(space, connection)),
  spaceClear: (space, connection) => keychainDelete(lmsLegacySpaceAccount(space, connection), "could not remove the sign-in from the keychain"),
  vaultGet: (connection) => keychainGet(lmsVaultAccount(connection)),
  vaultSet: (connection, secret) => keychainSet(lmsVaultAccount(connection), secret),
};

export type Report = { moved: string[]; notes: string[] };

function lstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

export function run(keys: Keys = keychainKeys): Report {
  const report: Report = { moved: [], notes: [] };
  let anyOld = false;
  for (const space of spaces()) {
    let dir: string;
    try {
      dir = spaceDir(space);
    } catch {
      continue;
    }
    if (lstat(path.join(dir, STATE_DIR, FILE))) anyOld = true;
    try {
      moveSpace(space, dir, keys, report);
    } catch (e) {
      report.notes.push(`${space}: ${msg(e)}`);
    }
  }
  // Only while a space still had its own course sites: a normal launch reads nothing from the keychain.
  if (anyOld) adoptLeftSignIns(keys, report);
  return report;
}

function adoptLeftSignIns(keys: Keys, report: Report): void {
  let st: Store;
  try {
    st = load(vaultRoot());
  } catch {
    return;
  }
  for (const conn of st.connections.filter((c) => !c.signedIn)) {
    for (const space of spaces()) {
      let found: string | null;
      try {
        found = keys.spaceGet(space, conn.id);
      } catch (e) {
        report.notes.push(`${space}: the sign-in for ${conn.id} couldn’t be read yet (${msg(e)}); trying again next time`);
        break;
      }
      if (found === null) continue;
      let moved = false;
      try {
        if (keys.vaultGet(conn.id) !== null) moved = true;
        else {
          keys.vaultSet(conn.id, found);
          moved = keys.vaultGet(conn.id) === found;
        }
      } catch {
        moved = false;
      }
      if (moved) {
        try {
          keys.spaceClear(space, conn.id);
        } catch {
          // A leftover legacy entry is harmless.
        }
        markSignedIn(conn.id, true);
        report.moved.push(`${space}: the sign-in for ${conn.id} → the vault`);
      }
      break;
    }
  }
}

function moveSpace(space: string, dir: string, keys: Keys, report: Report): void {
  const root = vaultRoot();
  const oldFile = path.join(dir, STATE_DIR, FILE);
  const oldGrades = path.join(dir, STATE_DIR, GRADES_FILE);
  if (!lstat(oldFile)) {
    if (lstat(oldGrades)?.isFile()) {
      mergeGrades(dir, load(root));
      fs.rmSync(oldGrades, { force: true });
    }
    return;
  }
  const old = load(dir);
  const fresh = load(root);
  const moves: [string, string][] = [];
  const keysMoved: string[] = [];
  for (const conn of old.connections) {
    if (!getConn(fresh, conn.id)) fresh.connections.push({ ...structuredClone(conn), courses: {}, signedIn: false });
    for (const [cid, state] of Object.entries(conn.courses)) {
      const taken = folders(fresh);
      const target = getConn(fresh, conn.id)!;
      let folder: string;
      const there = target.courses[cid];
      if (there) folder = there.folder;
      else {
        folder = freeFolder(root, state.folder, taken);
        target.courses[cid] = { ...structuredClone(state), folder };
      }
      if ((target.lastSync ?? -1) < (conn.lastSync ?? -1)) target.lastSync = conn.lastSync;
      if (target.schoolName === undefined && conn.schoolName !== undefined) target.schoolName = conn.schoolName;
      moves.push([state.folder, folder]);
      keysMoved.push(courseKey(conn.id, cid));
    }
  }
  save(root, fresh);
  allowAll([space], keysMoved);

  for (const conn of old.connections) {
    let had: string | null;
    try {
      had = keys.spaceGet(space, conn.id);
    } catch (e) {
      throw new Error(`the sign-in for ${conn.id} couldn’t be read yet (${msg(e)}); trying again next time`);
    }
    const inVault = keys.vaultGet(conn.id);
    let signedIn = false;
    if (inVault !== null) signedIn = true;
    else if (had !== null) {
      keys.vaultSet(conn.id, had);
      signedIn = keys.vaultGet(conn.id) === had;
    }
    if (signedIn) {
      keys.spaceClear(space, conn.id);
      markSignedIn(conn.id, true);
    }
  }

  mergeGrades(dir, fresh);

  let coursesRoot: string;
  try {
    let real = root;
    try {
      real = fs.realpathSync.native(root);
    } catch {
      // dirIn says what's wrong
    }
    coursesRoot = dirIn(real, COURSES_DIR);
  } catch (e) {
    throw new Error(`the courses folder couldn’t be made: ${msg(e)}`);
  }
  for (const [from, to] of moves) {
    const src = path.join(dir, COURSES_DIR, from);
    const dst = path.join(coursesRoot, to);
    const plain = segment(from) === from && lstat(path.join(dir, COURSES_DIR))?.isDirectory() === true;
    const srcOk = plain && lstat(src)?.isDirectory() === true;
    const dstThere = lstat(dst) !== null;
    if (srcOk && !dstThere) {
      try {
        fs.renameSync(src, dst);
      } catch (e) {
        throw new Error(`“${from}” couldn’t be moved: ${msg(e)}`);
      }
      report.moved.push(`${space}/courses/${from} → courses/${to}`);
    } else if (srcOk && dstThere) {
      report.notes.push(`${space}/courses/${from} stays where it is: the vault already has courses/${to}.`);
    }
  }
  const left = path.join(dir, COURSES_DIR);
  if (lstat(left)?.isDirectory()) {
    fs.rmSync(path.join(left, ".DS_Store"), { force: true });
    try {
      fs.rmdirSync(left);
    } catch {
      // Not empty: the person's own files stay.
    }
  }
  remove(oldGrades);
  remove(oldFile);
}

function freeFolder(root: string, want: string, taken: string[]): string {
  const base = segment(want);
  const used = (f: string) => taken.some((t) => t.toLowerCase() === f.toLowerCase()) || lstat(path.join(root, COURSES_DIR, f)) !== null;
  if (!used(base)) return base;
  for (let n = 2; ; n++) {
    const f = `${base} (${n})`;
    if (!used(f)) return f;
  }
}

function mergeGrades(dir: string, fresh: Store): void {
  const theirs = loadGrades(dir);
  if (!Object.keys(theirs.courses).length) return;
  const root = vaultRoot();
  const book = loadGrades(root);
  for (const [key, rec] of Object.entries(theirs.courses)) {
    if (key in book.courses) continue;
    const state = getConn(fresh, rec.connection)?.courses[rec.courseId];
    book.courses[key] = state ? { ...rec, folder: `${COURSES_DIR}/${state.folder}` } : rec;
  }
  saveGrades(root, book);
}

function remove(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`${p} couldn’t be removed: ${msg(e)}`);
  }
}
