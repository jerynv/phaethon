// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// (The process-group watcher script and the kill-the-group-on-exit pattern.)
import { spawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import fs from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { homeDir, isTest } from "../env.ts";
import { killGroup, type Run } from "../core/runs.ts";
import { prepareWindowsChildren, watchWindowsChild } from "../core/windows-jobs.ts";
import { CLI, type CliId } from "./cli.ts";
import { npmShim } from "./windows-command.ts";

/**
 * Finding the CLIs and running them. Every child leads its own process group
 * (so a stop reaches whatever it started), is registered on its Run (so the
 * core's shutdown kills it), and is watched by a tiny shell that kills the
 * group if the core itself dies without cleaning up. The prompt always goes
 * over stdin, never argv.
 */

export function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    return process.platform === "win32" ? /\.(exe|com|cmd|bat)$/i.test(p) : (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Where installers put command-line tools, none of which is on PATH when a macOS app is opened from Finder. */
export function commonBinDirs(): string[] {
  const dirs: string[] = [];
  const home = homeDir();
  if (home) for (const d of [".local/bin", ".bun/bin", ".npm-global/bin", ".volta/bin"]) dirs.push(path.join(home, d));
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) dirs.push(path.join(appData, "npm"));
    if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, "nodejs"));
    return dirs;
  }
  dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  return dirs;
}

function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

/** The first executable `name` on PATH, then in `extra`. No login-shell lookup. */
export function findOnPath(name: string, extra: string[]): string | null {
  const extensions = process.platform === "win32" && !path.extname(name)
    ? [...new Set([".exe", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((s) => /^\.(exe|com|bat|cmd)$/i.test(s)).map((s) => s.toLowerCase())])]
    : [""];
  for (const dir of [...pathDirs(), ...extra]) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** Tests and development builds may point at a scripted fake CLI (never honoured in a packaged app). */
function override(cli: CliId): string | null {
  if (!isTest() && process.env.PHAETHON_DEV !== "1") return null;
  const value = process.env[`PHAETHON_${cli.toUpperCase()}_BIN`];
  return value ? value : null;
}

/** The CLI's binary as installed (an instance may name another; see instances.ts `binary`). */
export function findBinary(cli: CliId): string | null {
  const forced = override(cli);
  if (forced) return forced;
  if (cli === "claude") {
    const home = homeDir();
    return findOnPath("claude", process.platform === "win32" ? commonBinDirs() : home ? [path.join(home, ".local", "bin")] : []);
  }
  return findOnPath(cli, commonBinDirs());
}

/** PATH for a Codex or Gemini child: the usual one, then the CLI's own folder and the installers' folders, so a JavaScript CLI finds `node`. */
export function childPath(bin: string): string {
  const dirs = pathDirs();
  for (const d of [path.dirname(bin), ...commonBinDirs()]) if (!dirs.includes(d)) dirs.push(d);
  return dirs.join(path.delimiter);
}

/** Environment for a child of `cli`: the parent's, without the variables a parent session of that CLI leaves behind. */
export function scrubbedEnv(cli: CliId, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of CLI[cli].inheritedVars) delete env[name];
  return env;
}

/**
 * Keeps the group alive only while the core is: the watcher waits on fd 3, a
 * pipe only the core holds; when it reads EOF (the core exited or crashed)
 * it ends the whole group. `exec` replaces the shell with the CLI, so the
 * CLI's pid is the group id.
 */
const GROUP_WATCH_SCRIPT = [
  "{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep 5; kill -KILL 0; } </dev/null >/dev/null 2>&1 &",
  'exec "$@" 3<&-',
].join("\n");

export type Exit = { code: number | null; signal: NodeJS.Signals | null };

export type GroupChild = {
  pid: number;
  child: ChildProcess;
  stdin: Writable | null;
  stdout: Readable;
  /** Resolves once the process has exited and been reaped. */
  exited: Promise<Exit>;
  hasExited(): boolean;
  /**
   * The first 64 KiB of stderr (the rest is drained so the child never blocks).
   * Resolves at stderr's end, or `graceMs` after the process exited, so a
   * descendant holding stderr open can't hang the caller.
   */
  stderrText(graceMs?: number): Promise<string>;
  /** Closes the core's ends of the pipes. */
  dispose(): void;
};

export type SpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  run?: Run;
  /** "ignore" gives the child /dev/null as stdin. */
  stdin?: "pipe" | "ignore";
  /** Written to stdin, which is then closed (the prompt; never argv). */
  input?: string;
  /** Removes the variables a parent session of this CLI leaves behind (see `scrubbedEnv`). */
  cli?: CliId;
};

const STDERR_CAP = 64 * 1024;

/** Starts `bin args` in its own process group, watched and registered on `run`. Rejects if it can't start. */
export function spawnInGroup(bin: string, args: string[], opts: SpawnOptions): Promise<GroupChild> {
  const unix = process.platform !== "win32";
  const entry = unix ? null : npmShim(bin);
  if (entry) {
    const node = process.versions.electron ? findOnPath("node", [path.dirname(bin), ...commonBinDirs()]) : process.execPath;
    if (!node) return Promise.reject(new Error("Node.js is needed to run this npm-installed assistant."));
    bin = node;
    args = [entry, ...args];
  }
  // Batch launchers use cmd.exe. Reject line breaks rather than letting them
  // become shell syntax; prompts are sent over stdin and may contain any text.
  if (!unix && /\.(cmd|bat)$/i.test(bin) && [bin, ...args].some((s) => /[\r\n\0]/.test(s))) {
    return Promise.reject(new Error("Command launcher arguments must be single-line strings."));
  }
  prepareWindowsChildren();
  const stdinMode = opts.stdin ?? "pipe";
  const env = opts.cli ? scrubbedEnv(opts.cli, opts.env) : opts.env;
  const child = unix
    ? spawn("/bin/sh", ["-c", GROUP_WATCH_SCRIPT, "phaethon-cli", bin, ...args], {
        cwd: opts.cwd,
        env,
        stdio: [stdinMode, "pipe", "pipe", "pipe"],
        detached: true,
      })
    : crossSpawn(bin, args, { cwd: opts.cwd, env, stdio: [stdinMode, "pipe", "pipe"], windowsHide: true });

  let closeJob = () => {};
  if (!unix && child.pid) {
    try {
      closeJob = watchWindowsChild(child.pid);
    } catch (e) {
      child.kill("SIGKILL");
      return Promise.reject(e);
    }
  }

  return new Promise<GroupChild>((resolve, reject) => {
    child.once("error", (e) => reject(e));
    child.once("spawn", () => {
      const pid = child.pid!;
      opts.run?.groups.add(pid);
      const watchPipe = unix ? (child.stdio[3] as (Readable & { unref?: () => void }) | null) : null;
      // The watcher pipe must not keep the core running by itself.
      watchPipe?.unref?.();
      watchPipe?.on("error", () => {});

      let exit: Exit | undefined;
      const exited = new Promise<Exit>((done) => {
        child.once("exit", (code, signal) => {
          exit = { code, signal };
          // Whatever the CLI started dies with it (and the watcher with them).
          if (unix) killGroup(pid, "SIGKILL");
          closeJob();
          opts.run?.groups.delete(pid);
          watchPipe?.destroy();
          done(exit);
        });
      });

      const chunks: Buffer[] = [];
      let size = 0;
      let stderrEnded = false;
      const stderrDone = new Promise<void>((done) => {
        child.stderr!.on("data", (d: Buffer) => {
          if (size < STDERR_CAP) {
            const take = d.subarray(0, STDERR_CAP - size);
            chunks.push(take);
            size += take.length;
          }
        });
        child.stderr!.once("close", () => {
          stderrEnded = true;
          done();
        });
        child.stderr!.on("error", () => {});
      });
      child.stdout!.on("error", () => {});
      child.stdin?.on("error", () => {});
      // Write errors mean the CLI already exited; its exit status says why.
      if (opts.input !== undefined) child.stdin?.end(opts.input);

      resolve({
        pid,
        child,
        stdin: child.stdin,
        stdout: child.stdout!,
        exited,
        hasExited: () => exit !== undefined,
        async stderrText(graceMs = 1000) {
          if (!stderrEnded) {
            await Promise.race([stderrDone, exited.then(() => sleep(graceMs))]);
          }
          return Buffer.concat(chunks).toString("utf8");
        },
        dispose() {
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          watchPipe?.destroy();
        },
      });
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Waits up to `ms` for the child to exit; true if it did. */
export async function exitWithin(gc: GroupChild, ms: number): Promise<boolean> {
  if (gc.hasExited()) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
  const done = await Promise.race([gc.exited.then(() => true as const), timeout]);
  clearTimeout(timer);
  return done;
}

/**
 * Stops a child and everything it started: SIGTERM to the group, 1.5 s, then
 * SIGKILL to the group and the child; always reaps; then SIGKILL to the group
 * once more for descendants that ignored SIGTERM and still hold a pipe.
 */
export async function stopGroup(gc: GroupChild, run?: Run, graceMs = 1500): Promise<Exit> {
  const unix = process.platform !== "win32";
  if (!gc.hasExited()) {
    if (unix) killGroup(gc.pid, "SIGTERM");
    else killGroup(gc.pid);
    if (!(await exitWithin(gc, graceMs))) {
      if (unix) killGroup(gc.pid, "SIGKILL");
      try {
        gc.child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  const exit = await gc.exited;
  if (unix) killGroup(gc.pid, "SIGKILL");
  run?.groups.delete(gc.pid);
  gc.dispose();
  return exit;
}

/** Calls `onLine` for each `\n`-separated line (a trailing `\r` dropped); resolves at end of stream. Lines over `maxLine` bytes end the read. */
export function readLines(stream: Readable, onLine: (line: string) => void, maxLine = 64 * 1024 * 1024): Promise<void> {
  return new Promise((resolve) => {
    let buf = "";
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (buf) {
        const rest = buf;
        buf = "";
        try {
          onLine(rest.replace(/\r$/, ""));
        } catch {
          // a listener's failure ends nothing
        }
      }
      resolve();
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (finished) return;
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        try {
          onLine(line);
        } catch {
          // a listener's failure ends nothing
        }
        if (finished) return;
      }
      if (buf.length > maxLine) {
        buf = "";
        finished = true;
        stream.destroy();
        resolve();
      }
    });
    stream.once("end", finish);
    stream.once("close", finish);
    stream.once("error", finish);
  });
}
