import fs from "node:fs";
import path from "node:path";
import { Refusal, messageOf } from "../rpc/registry.ts";
import { realpath } from "../core/fsx.ts";
import { filesFolder, freeName } from "./add.ts";
import { folderIn } from "./browse.ts";
import { checkFileName } from "./manage.ts";

/**
 * Files dropped on the Files view: their bytes come from the page (as the
 * composer's attachments do), at most 20 files and 30 MB at once, and are
 * written into the folder on show (the space's `files/` folder when that is
 * the space itself, as Add files… does). A taken name gets a number, so
 * nothing is replaced; every file is created exclusively, never through a link.
 */

export const DROP_MAX_FILES = 20;
export const DROP_MAX_BYTES = 30 * 1024 * 1024;

export type Dropped = { name: string; data: string };

export function uploadToFolder(spaceRoot: string, folder: string, files: Dropped[]): { paths: string[] } {
  if (!Array.isArray(files) || !files.length) return { paths: [] };
  if (files.length > DROP_MAX_FILES) throw new Refusal(`That’s more than ${DROP_MAX_FILES} files, so nothing was added. Use Add files… instead.`);
  const decoded = files.map((f) => ({ name: checkFileName(f?.name), bytes: Buffer.from(String(f?.data ?? ""), "base64") }));
  const total = decoded.reduce((n, f) => n + f.bytes.length, 0);
  if (total > DROP_MAX_BYTES) throw new Refusal("That’s more than 30 MB, so nothing was added. Use Add files… for big files.");
  const dir = folder.trim() ? folderIn(spaceRoot, folder).real : filesFolder(spaceRoot);
  const root = realpath(spaceRoot);
  const paths: string[] = [];
  for (const f of decoded) {
    const name = freeName(dir, f.name, false);
    try {
      fs.writeFileSync(path.join(dir, name), f.bytes, { flag: "wx" });
    } catch (e) {
      throw new Refusal(`“${name}” couldn’t be added: ${messageOf(e)}. What was added before it is kept.`);
    }
    paths.push(path.relative(root, path.join(realpath(dir), name)).split(path.sep).join("/"));
  }
  return { paths };
}
