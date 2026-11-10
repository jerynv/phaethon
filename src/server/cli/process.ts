// STUB: owned by cli worker
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeDir } from "../env.ts";
import { killGroup, type Run } from "../core/runs.ts";

export type Cli = "claude" | "codex" | "gemini";

const CONFIG_VAR: Record<Cli, string> = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME", gemini: "GEMINI_CLI_HOME" };
const OWN_HOME: Record<Cli, boolean> = { claude: false, codex: true, gemini: true };
const SESSION_VARS: Record<Cli, string[]> = {
  claude: [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_PID",
  ],
  codex: ["CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_CI"],
  gemini: [
    "GEMINI_CLI",
    "GEMINI_SYSTEM_MD",
    "GEMINI_WRITE_SYSTEM_MD",
    "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
    "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
    "GEMINI_CLI_TRUSTED_FOLDERS_PATH",
    "GEMINI_SANDBOX",
    "SANDBOX",
    "SEATBELT_PROFILE",
    "GEMINI_CLI_IDE_SERVER_PORT",
    "GEMINI_CLI_IDE_WORKSPACE_PATH",
  ],
};

function commonBinDirs(): string[] {
  const h = homeDir();
  const dirs = h ? [".local/bin", ".bun/bin", ".npm-global/bin", ".volta/bin"].map((d) => path.join(h, d)) : [];
  return [...dirs, "/opt/homebrew/bin", "/usr/local/bin"];
}

function findOnPath(name: string, extra: string[]): string | null {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  for (const dir of [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...extra]) {
    const p = path.join(dir, exe);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (process.platform === "win32" || (st.mode & 0o111) !== 0)) return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** The CLI's executable (`PHAETHON_<CLI>_BIN` overrides, for tests and development). */
export function findBinary(cli: Cli): string | null {
  const override = process.env[`PHAETHON_${cli.toUpperCase()}_BIN`];
  if (override) return override;
  return findOnPath(cli, cli === "claude" ? [path.join(homeDir(), ".local/bin")] : commonBinDirs());
}

export type SpawnOptions = {
  cli: Cli;
  cwd: string;
  configDir?: string | null;
  env?: Record<string, string>;
  run?: Run;
  /** Written to stdin, which is then closed. */
  stdin?: string;
};

/** Starts a CLI as the leader of its own process group, with the parent session's variables removed. */
export function spawnInGroup(bin: string, args: string[], opts: SpawnOptions): ChildProcess {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of SESSION_VARS[opts.cli]) delete env[k];
  if (opts.cli !== "claude") {
    const parts = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
    for (const d of [path.dirname(bin), ...commonBinDirs()]) if (!parts.includes(d)) parts.push(d);
    env.PATH = parts.join(path.delimiter);
  }
  let dir = opts.configDir ?? null;
  if (!dir && OWN_HOME[opts.cli]) dir = path.join(os.tmpdir(), "phaethon-no-cli-home");
  if (dir) {
    if (OWN_HOME[opts.cli]) fs.mkdirSync(dir, { recursive: true });
    env[CONFIG_VAR[opts.cli]] = dir;
  }
  Object.assign(env, opts.env ?? {});
  const child = spawn(bin, args, { cwd: opts.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  if (child.pid && opts.run) opts.run.groups.add(child.pid);
  child.stdin?.on("error", () => {});
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
  return child;
}

/** SIGTERM to the group, then SIGKILL after 1.5 s. */
export async function stopGroup(child: ChildProcess, run?: Run): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  killGroup(pid, "SIGTERM");
  const exited = await new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), 1500);
    child.once("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
  if (!exited) killGroup(pid, "SIGKILL");
  killGroup(pid, "SIGKILL");
  run?.groups.delete(pid);
}
