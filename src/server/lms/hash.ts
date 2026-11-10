import { createHash } from "node:crypto";
import fs from "node:fs";

/** SHA-256 as lowercase hex. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 of a plain file (lstat: never through a symlink), read in 64 KiB chunks. */
export function fileHex(file: string): string {
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new Error(`${file} is not a plain file`);
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** `fileHex`, or null when the file is missing or isn't a plain file. */
export function fileHexOrNull(file: string): string | null {
  try {
    return fileHex(file);
  } catch {
    return null;
  }
}

/** `fileHex` without blocking the event loop; null when missing or not a plain file. */
export async function fileHexAsync(file: string): Promise<string | null> {
  try {
    const st = await fs.promises.lstat(file);
    if (!st.isFile()) return null;
    const h = createHash("sha256");
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 64 * 1024 })) h.update(chunk as Buffer);
    return h.digest("hex");
  } catch {
    return null;
  }
}
