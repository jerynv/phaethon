import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Directory junctions exercise reparse-point checks on unprivileged Windows. */
export function symlink(target: string, dest: string, type?: fs.symlink.Type): void {
  const directory = type === "dir" || type === "junction" || fs.statSync(target, { throwIfNoEntry: false })?.isDirectory();
  fs.symlinkSync(target, dest, process.platform === "win32" && directory ? "junction" : type);
}

function fileSymlinksAvailable(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-symlink-probe-"));
  try {
    fs.writeFileSync(path.join(dir, "file"), "test");
    fs.symlinkSync(path.join(dir, "file"), path.join(dir, "link"), "file");
    return true;
  } catch (e) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes((e as NodeJS.ErrnoException).code ?? "")) return false;
    throw e;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// File symlinks need Windows Developer Mode or a privileged runner. Never
// substitute hard links: they would no longer test symbolic-link rejection.
export const canSymlinkFiles = fileSymlinksAvailable();
