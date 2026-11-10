import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Refusal, messageOf } from "../rpc/registry.ts";
import { isWithin, lstatOrNull, realpath } from "../core/fsx.ts";

/**
 * Files and folders the user adds to a space from elsewhere (Add files… / Add
 * a folder…), from the desktop's own picker. They are copied, never moved or
 * linked, into the space's `files/` folder. Hidden files and links are left
 * out, nothing in the vault is copied into it again, and a taken name gets a
 * number ("Resume 2.pdf"), so nothing is replaced. A folder is copied under a
 * hidden name and renamed when whole. Nothing is ever written through a link:
 * names count as taken when anything (a dangling link included) is there, and
 * every copy refuses an existing destination.
 */

export const FOLDER = "files";
const MAX_FILES = 5000;
const MAX_BYTES = 1024 * 1024 * 1024;

export type Added = { paths: string[]; files: number; skipped: number };
type Plan = { items: { src: string; inside: string[] | null }[]; bytes: number; files: number; skipped: number };

const tooMany = () =>
  new Refusal(`That’s more than ${MAX_FILES} files, so nothing was added. Add a smaller folder, or the folders inside it one at a time.`);

function byName(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function walk(root: string, rel: string, out: string[], plan: Plan): void {
  const dir = path.join(root, rel);
  let names: string[];
  try {
    names = fs.readdirSync(dir).sort(byName);
  } catch (e) {
    throw new Refusal(`“${dir}” couldn’t be read: ${messageOf(e)}`);
  }
  for (const name of names) {
    const p = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      throw new Refusal(`“${p}” couldn’t be read: ${messageOf(e)}`);
    }
    const child = rel ? path.join(rel, name) : name;
    if (name.startsWith(".") || st.isSymbolicLink()) plan.skipped++;
    else if (st.isDirectory()) {
      out.push(child);
      walk(root, child, out, plan);
    } else if (st.isFile()) {
      plan.files++;
      plan.bytes += st.size;
      out.push(child);
    } else plan.skipped++;
    if (plan.files > MAX_FILES) throw tooMany();
  }
}

function makePlan(sources: string[], vaultRoot: string): Plan {
  let vault: string;
  try {
    vault = realpath(vaultRoot);
  } catch {
    vault = vaultRoot;
  }
  const plan: Plan = { items: [], bytes: 0, files: 0, skipped: 0 };
  for (const src of sources) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(src);
    } catch {
      throw new Refusal(`“${src}” isn’t there any more.`);
    }
    if (st.isSymbolicLink()) {
      plan.skipped++;
      continue;
    }
    let real: string;
    try {
      real = realpath(src);
    } catch (e) {
      throw new Refusal(`“${src}” couldn’t be read: ${messageOf(e)}`);
    }
    if (isWithin(real, vault)) {
      throw new Refusal("That’s already in your Phaethon folder, so nothing was added. Anything inside a space can already be read there.");
    }
    if (isWithin(vault, real)) throw new Refusal("That folder holds your Phaethon folder, so nothing was added. Pick a folder inside it instead.");
    if (st.isDirectory()) {
      const inside: string[] = [];
      walk(real, "", inside, plan);
      plan.items.push({ src: real, inside });
    } else if (st.isFile()) {
      plan.files++;
      plan.bytes += st.size;
      if (plan.files > MAX_FILES) throw tooMany();
      plan.items.push({ src: real, inside: null });
    } else plan.skipped++;
  }
  if (plan.bytes > MAX_BYTES) {
    throw new Refusal(
      `That’s ${(plan.bytes / 1e9).toFixed(1)} GB, more than the 1 GB Phaethon adds at once, so nothing was added. Add a smaller folder, or the folders inside it one at a time.`,
    );
  }
  return plan;
}

function taken(p: string): boolean {
  try {
    return lstatOrNull(p) !== null;
  } catch {
    return true;
  }
}

/** `name`, or `stem n.ext` (folders keep their whole name), the first one nothing occupies. */
function freeName(dir: string, name: string, isDir: boolean): string {
  if (!taken(path.join(dir, name))) return name;
  const i = name.lastIndexOf(".");
  const [stem, ext] = i > 0 && !isDir ? [name.slice(0, i), name.slice(i)] : [name, ""];
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}${ext}`;
    if (!taken(path.join(dir, candidate))) return candidate;
  }
}

async function copyTree(src: string, inside: string[], dest: string): Promise<void> {
  fs.mkdirSync(dest);
  for (const rel of inside) {
    const from = path.join(src, rel);
    const to = path.join(dest, rel);
    if (fs.lstatSync(from).isDirectory()) fs.mkdirSync(to, { recursive: true });
    else await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  }
}

/** The space's `files/` folder, made if missing; refused when it is a link or not a folder inside the space. */
function filesFolder(spaceDir: string): string {
  const dir = path.join(spaceDir, FOLDER);
  try {
    const st = lstatOrNull(dir);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`“${FOLDER}” in this space isn’t a folder`);
    fs.mkdirSync(dir, { recursive: true });
    if (!isWithin(realpath(dir), realpath(spaceDir))) throw new Error(`“${FOLDER}” leads outside this space`);
  } catch (e) {
    throw new Refusal(`The space’s files folder couldn’t be made: ${messageOf(e)}`);
  }
  return dir;
}

export async function addToSpace(spaceDir: string, vaultRoot: string, sources: string[]): Promise<Added> {
  const plan = makePlan(sources, vaultRoot);
  const dir = filesFolder(spaceDir);
  const paths: string[] = [];
  for (const { src, inside } of plan.items) {
    const isDir = inside !== null;
    const name = freeName(dir, path.basename(src) || "Added", isDir);
    try {
      if (isDir) {
        const temp = path.join(dir, `.adding-${process.pid}-${name}`);
        try {
          await copyTree(src, inside, temp);
          if (taken(path.join(dir, name))) throw Object.assign(new Error("the name was taken meanwhile"), { code: "EEXIST" });
          fs.renameSync(temp, path.join(dir, name));
        } catch (e) {
          fs.rmSync(temp, { recursive: true, force: true });
          throw e;
        }
      } else await fsp.copyFile(src, path.join(dir, name), fs.constants.COPYFILE_EXCL);
    } catch (e) {
      throw new Refusal(`“${name}” couldn’t be copied: ${messageOf(e)}. What was added before it is kept.`);
    }
    paths.push(`${FOLDER}/${name}`);
  }
  return { paths, files: plan.files, skipped: plan.skipped };
}
