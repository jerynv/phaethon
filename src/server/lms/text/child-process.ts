import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Starting the text child (child.ts). From source (tests, dev) it runs the
 * TypeScript through tsx; in the built app it is `text-child.mjs` beside the
 * bundled core. Electron's own binary runs it as Node.
 */

export const CHILD_FLAG = "--phaethon-text-child";
const MEMORY_MB = 2048;

const here = path.dirname(fileURLToPath(import.meta.url));

export function childCommand(mode: string, args: string[]): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const source = path.join(here, "child.ts");
  const node = [`--max-old-space-size=${MEMORY_MB}`];
  let script: string[];
  if (fs.existsSync(source)) {
    const loader = createRequire(import.meta.url).resolve("tsx");
    script = ["--import", pathToFileURL(loader).href, source];
  } else script = [path.join(here, "text-child.mjs")];
  return { cmd: process.execPath, args: [...node, ...script, CHILD_FLAG, mode, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
}

/** Starts a child in its own process group (so what it starts dies with it). */
export function spawnGroup(cmd: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  return spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env, detached: process.platform !== "win32", windowsHide: true });
}

export function killGroup(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // gone
    }
  }
}

export class ChildError extends Error {}

/**
 * Runs the child in `mode`: its stdout (at most `cap` bytes), or why not.
 * Killed after `limitMs`, or at once when `signal` aborts ("cancelled").
 */
export function runChild(mode: string, args: string[], limitMs: number, cap: number, signal: AbortSignal | undefined, what: { start: string; slow: string; failed: string }): Promise<Buffer> {
  if (signal?.aborted) return Promise.reject(new ChildError("cancelled"));
  const c = childCommand(mode, args);
  return new Promise((resolve, reject) => {
    const child = spawnGroup(c.cmd, c.args, c.env);
    const out: Buffer[] = [];
    let outLen = 0;
    let err = "";
    let settled = false;
    const finish = (f: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      f();
    };
    const onAbort = () =>
      finish(() => {
        killGroup(child);
        reject(new ChildError("cancelled"));
      });
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () =>
        finish(() => {
          killGroup(child);
          reject(new ChildError(what.slow));
        }),
      limitMs,
    );
    child.stdout!.on("data", (d: Buffer) => {
      if (outLen < cap) out.push(d.subarray(0, cap - outLen));
      outLen += d.length;
    });
    child.stderr!.on("data", (d: Buffer) => {
      if (err.length < 4096) err += d.toString("utf8").slice(0, 4096 - err.length);
    });
    child.on("error", (e) => finish(() => reject(new ChildError(`${what.start}: ${e.message}`))));
    child.on("close", (code) =>
      finish(() => {
        if (code !== 0) {
          const e = err.trim();
          reject(new ChildError(e ? [...e].slice(0, 200).join("") : what.failed));
        } else resolve(Buffer.concat(out));
      }),
    );
  });
}
