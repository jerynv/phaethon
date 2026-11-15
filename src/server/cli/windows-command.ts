import fs from "node:fs";
import path from "node:path";

/** npm's standard Node shim, run directly so multiline arguments never enter cmd.exe. */
export function npmShim(bin: string): string | null {
  if (!/\.(cmd|bat)$/i.test(bin)) return null;
  try {
    if (fs.statSync(bin).size > 32 * 1024) return null;
    const text = fs.readFileSync(bin, "utf8");
    if (!text.includes(":find_dp0") || !text.includes('SET "_prog=node"')) return null;
    const match = /"%_prog%"\s+"%dp0%[\\/]([^"\r\n]+\.(?:[cm]?js))"\s+%\*/i.exec(text);
    if (!match) return null;
    const entry = path.resolve(path.dirname(bin), match[1]);
    return fs.statSync(entry).isFile() ? entry : null;
  } catch {
    return null;
  }
}
