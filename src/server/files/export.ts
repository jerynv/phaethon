import fs from "node:fs";
import path from "node:path";
import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { Refusal, messageOf } from "../rpc/registry.ts";
import { isWithin, realpath } from "../core/fsx.ts";
import { today } from "../attachments/attachments.ts";

/**
 * Export: one whole space as a single .zip, its conversations and attachments
 * under `.phaethon/` included, inside one top folder named after the space id.
 * The walk never follows a symlink, every file is re-checked to be inside the
 * space and opened without following a link, and the zip is written beside
 * its destination under a temporary name and renamed into place when whole.
 */

/** "School 2026-10-10.zip": characters a file name can't hold dropped, the id when nothing is left. */
export function suggestedName(display: string, id: string): string {
  const clean = [...display].filter((c) => !/\p{Cc}/u.test(c) && !'/\\:*?"<>|'.includes(c)).join("");
  const base = clean.trim().replace(/^\.+/, "").trim() || id;
  return `${base} ${today()}.zip`;
}

type Entry = { rel: string; dir: boolean };

function byName(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Folders and plain files under `root`, depth first in name order; links, sockets and devices are left out. */
function walk(root: string, rel: string, out: Entry[]): void {
  const children = fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => byName(a.name, b.name));
  for (const child of children) {
    const p = rel ? `${rel}/${child.name}` : child.name;
    if (child.isDirectory()) {
      out.push({ rel: p, dir: true });
      walk(root, p, out);
    } else if (child.isFile()) out.push({ rel: p, dir: false });
  }
}

const CHUNK = 1024 * 1024;
const ZIP32_LIMIT = 0xffffffff;

export type Exported = { file: string; files: number };

/** Writes the space folder `spaceDir` to `dest` as a zip whose top folder is `id`. */
export async function exportSpace(spaceDir: string, id: string, dest: string): Promise<Exported> {
  let root: string;
  try {
    root = realpath(spaceDir);
  } catch (e) {
    throw new Refusal(`The space’s folder couldn’t be found: ${messageOf(e)}`);
  }
  const entries: Entry[] = [];
  try {
    walk(root, "", entries);
  } catch (e) {
    throw new Refusal(`The space’s files couldn’t be listed: ${messageOf(e)}`);
  }
  const fileName = path.basename(dest);
  if (!fileName) throw new Refusal("Choose a file name for the export.");
  const tmp = path.join(path.dirname(dest), `.${fileName}.part`);
  let files: number;
  try {
    files = await writeZip(root, id, entries, tmp);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Refusal(`The export couldn’t be saved as “${fileName}”: ${messageOf(e)}`);
  }
  return { file: dest, files };
}

async function writeZip(root: string, id: string, entries: Entry[], to: string): Promise<number> {
  let fd: number;
  try {
    fd = fs.openSync(to, "w");
  } catch (e) {
    throw new Refusal(`The export couldn’t be saved there: ${messageOf(e)}`);
  }
  const saveErr = (e: unknown) => new Refusal(`The export couldn’t be written: ${messageOf(e)}`);
  let written = 0;
  let failure: unknown;
  try {
    const zip = new Zip((err, data) => {
      if (failure) return;
      if (err) {
        failure = saveErr(err);
        return;
      }
      try {
        fs.writeSync(fd, data);
        written += data.length;
      } catch (e) {
        failure = saveErr(e);
      }
    });
    const check = () => {
      if (failure) throw failure;
      // Archives this large need zip64, which the writer doesn't do.
      if (written > ZIP32_LIMIT) throw new Refusal("The export would be larger than 4 GB, so nothing was exported.");
    };
    const addDir = (name: string) => {
      const d = new ZipPassThrough(name);
      zip.add(d);
      d.push(new Uint8Array(0), true);
      check();
    };
    addDir(`${id}/`);
    let files = 0;
    const buf = Buffer.alloc(CHUNK);
    for (const entry of entries) {
      const name = `${id}/${entry.rel}`;
      if (entry.dir) {
        addDir(`${name}/`);
        continue;
      }
      const shown = entry.rel;
      const full = path.join(root, entry.rel);
      // A folder on the way swapped for a link since the walk would lead out.
      let real: string;
      try {
        real = realpath(full);
      } catch (e) {
        throw new Refusal(`“${shown}” couldn’t be read, so nothing was exported: ${messageOf(e)}`);
      }
      if (!isWithin(real, root)) throw new Refusal(`“${shown}” now leads outside the space, so nothing was exported.`);
      let src: number;
      try {
        src = fs.openSync(full, fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW));
      } catch (e) {
        throw new Refusal(`“${shown}” couldn’t be read, so nothing was exported: ${messageOf(e)}`);
      }
      try {
        if (fs.fstatSync(src).size >= ZIP32_LIMIT) throw new Refusal(`“${shown}” is 4 GB or larger, so nothing was exported.`);
        const f = new ZipDeflate(name, { level: 6 });
        zip.add(f);
        for (;;) {
          let n: number;
          try {
            n = fs.readSync(src, buf, 0, CHUNK, null);
          } catch (e) {
            throw new Refusal(`“${shown}” couldn’t be copied into the export: ${messageOf(e)}`);
          }
          f.push(Uint8Array.from(buf.subarray(0, n)), n === 0);
          check();
          if (n === 0) break;
          // Let other calls through during a large export.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } finally {
        fs.closeSync(src);
      }
      files++;
    }
    zip.end();
    check();
    try {
      fs.fsyncSync(fd);
    } catch (e) {
      throw saveErr(e);
    }
    return files;
  } finally {
    fs.closeSync(fd);
  }
}
