import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { killWindowsChild, prepareWindowsChildren, watchWindowsChild } from "../../core/windows-jobs.ts";

/**
 * Starting the text child (child.ts). From source (tests, dev) it runs the
 * TypeScript through tsx; in the built app it is `text-child.mjs` beside the
 * bundled core.
 *
 * Inside the desktop app the core is an Electron utility process and the
 * RunAsNode fuse is off, so Electron's binary can't be started as Node: there
 * the child is a worker thread with its own heap limit, terminated on timeout
 * or cancel. Elsewhere (tests, a standalone core) it is a separate process in
 * its own group, so whatever it starts dies with it.
 */

export const CHILD_FLAG = "--phaethon-text-child";
const MEMORY_MB = 2048;

const here = path.dirname(fileURLToPath(import.meta.url));

/** How to start a child: a process, or (in the desktop app) a worker thread running a built script. */
export type ChildSpec = { cmd: string; args: string[]; env?: NodeJS.ProcessEnv } | { worker: string; argv: string[] };

function inWorker(): boolean {
  return Boolean(process.versions.electron) || process.env.PHAETHON_TEXT_WORKER === "1";
}

export function childCommand(mode: string, args: string[]): ChildSpec {
  const built = process.env.PHAETHON_TEXT_CHILD || path.join(here, "text-child.mjs");
  if (inWorker() && fs.existsSync(built)) return { worker: built, argv: [CHILD_FLAG, mode, ...args] };
  const source = path.join(here, "child.ts");
  const node = [`--max-old-space-size=${MEMORY_MB}`];
  let script: string[];
  if (fs.existsSync(source)) {
    const loader = createRequire(import.meta.url).resolve("tsx");
    script = ["--import", pathToFileURL(loader).href, source];
  } else script = [path.join(here, "text-child.mjs")];
  return { cmd: process.execPath, args: [...node, ...script, CHILD_FLAG, mode, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
}

/** A started child, process or worker, as the callers use it. */
export type ChildLike = {
  stdout: Readable;
  stderr: Readable;
  once(event: "spawn", listener: () => void): void;
  once(event: "error", listener: (e: Error) => void): void;
  on(event: "error", listener: (e: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
  /** Stops it and everything it started (as far as the platform allows). */
  kill(): void;
};

export function startChild(spec: ChildSpec): ChildLike {
  if ("worker" in spec) return startWorker(spec.worker, spec.argv);
  const child = spawnGroup(spec.cmd, spec.args, spec.env);
  // Keep ChildProcess.kill intact: killGroup's Windows path calls it.
  // Replacing it with this adapter's kill would recurse on cancellation.
  return {
    stdout: child.stdout!,
    stderr: child.stderr!,
    once: child.once.bind(child),
    on: child.on.bind(child),
    kill: () => killGroup(child),
  };
}

function startWorker(script: string, argv: string[]): ChildLike {
  const events = new EventEmitter();
  const worker = new Worker(script, { argv, stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB } });
  let online = false;
  let closed = false;
  const close = (code: number | null) => {
    if (closed) return;
    closed = true;
    events.emit("close", code);
  };
  worker.once("online", () => {
    online = true;
    events.emit("spawn");
  });
  worker.on("error", (e) => {
    if (!online) events.emit("error", e);
    else {
      worker.stderr.push(String(e?.message ?? e));
      close(1);
    }
  });
  worker.on("exit", (code) => close(code));
  return {
    stdout: worker.stdout,
    stderr: worker.stderr,
    once: (event: string, listener: (...a: never[]) => void) => void events.once(event, listener as (...a: unknown[]) => void),
    on: (event: string, listener: (...a: never[]) => void) => void events.on(event, listener as (...a: unknown[]) => void),
    kill: () => void worker.terminate(),
  } as ChildLike;
}

/** Starts a child in its own process group (so what it starts dies with it). */
export function spawnGroup(cmd: string, args: string[], env?: NodeJS.ProcessEnv): ChildProcess {
  prepareWindowsChildren();
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env, detached: process.platform !== "win32", windowsHide: true });
  if (process.platform === "win32" && child.pid) {
    try {
      const close = watchWindowsChild(child.pid);
      child.once("exit", close);
    } catch (e) {
      child.kill("SIGKILL");
      throw e;
    }
  }
  return child;
}

export function killGroup(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else if (!child.pid || !killWindowsChild(child.pid)) child.kill("SIGKILL");
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
    const child = startChild(c);
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
        child.kill();
        reject(new ChildError("cancelled"));
      });
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () =>
        finish(() => {
          child.kill();
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
