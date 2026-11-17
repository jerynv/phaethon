import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeDir, isTest } from "../env.ts";
import { claim, release, type Run } from "../core/runs.ts";
import { cliName, stderrSummary, type CliId } from "./cli.ts";
import { abortion } from "./drive.ts";
import { findBinary, findOnPath, isExecutable, spawnInGroup, stopGroup } from "./process.ts";

/**
 * Installing Claude Code or Codex for someone who doesn't have a terminal
 * habit, with the installer each company publishes for exactly that
 * (claude.ai/install.sh, chatgpt.com/codex/install.sh and their PowerShell
 * twins). Phaethon fetches the script from that address only, runs it as the
 * person, and then looks for the CLI where it always does. The installers
 * download, check and place the CLI themselves; Phaethon never handles the
 * CLI's files or, later, its sign-in. Gemini CLI has no standalone installer,
 * so it keeps its npm command.
 */

export type InstallableCli = "claude" | "codex";
export type InstallStatus = "installed" | "failed" | "cancelled" | "busy" | "unsupported";
export type InstallOutcome = { status: InstallStatus; message: string };

type Platform = NodeJS.Platform;

const SOURCES: Record<InstallableCli, { unix: string; windows: string; hosts: readonly string[] }> = {
  claude: { unix: "https://claude.ai/install.sh", windows: "https://claude.ai/install.ps1", hosts: ["claude.ai", "downloads.claude.ai"] },
  codex: { unix: "https://chatgpt.com/codex/install.sh", windows: "https://chatgpt.com/codex/install.ps1", hosts: ["chatgpt.com", "releases.openai.com"] },
};

/** How long an install may take: each downloads 100 MB or more, which took Claude Code's eight minutes on an ordinary connection. */
export const INSTALL_WAIT_MS = 30 * 60 * 1000;
/** An installer script is a few kilobytes; anything far larger isn't one. */
const MAX_SCRIPT_BYTES = 1024 * 1024;

export function isInstallable(cli: CliId): cli is InstallableCli {
  return cli === "claude" || cli === "codex";
}

export function installerUrl(cli: InstallableCli, platform: Platform = process.platform): string {
  return platform === "win32" ? SOURCES[cli].windows : SOURCES[cli].unix;
}

/** Only https, and only the company's own hosts, after any redirect. */
export function isOfficial(cli: InstallableCli, url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && SOURCES[cli].hosts.includes(u.hostname);
  } catch {
    return false;
  }
}

export const installRunKey = (cli: CliId) => `\0install:${cli}`;

export type FetchScript = (cli: InstallableCli, platform: Platform, signal: AbortSignal) => Promise<string>;

/** The official installer's text, refused if it came from anywhere else or doesn't look like a script. */
export const fetchScript: FetchScript = async (cli, platform, signal) => {
  const res = await fetch(installerUrl(cli, platform), { redirect: "follow", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  if (!res.ok) throw new Error(`${cliName(cli)}’s installer couldn’t be downloaded (${res.status}).`);
  if (!isOfficial(cli, res.url)) throw new Error(`${cliName(cli)}’s installer came from an address Phaethon doesn’t trust.`);
  const text = await res.text();
  if (!text.trim() || text.length > MAX_SCRIPT_BYTES || (platform !== "win32" && !text.startsWith("#!"))) {
    throw new Error(`What came back wasn’t ${cliName(cli)}’s installer.`);
  }
  return text;
};

/** Tests and development builds may name a local installer script (never honoured in a packaged app). */
function localScript(cli: InstallableCli): FetchScript | null {
  if (!isTest() && process.env.PHAETHON_DEV !== "1") return null;
  const file = process.env[`PHAETHON_${cli.toUpperCase()}_INSTALLER`];
  return file ? async () => fs.readFileSync(file, "utf8") : null;
}

/** The CLI where Phaethon looks for it, if it's really there. */
function installed(cli: InstallableCli): boolean {
  const found = findBinary(cli);
  return !!found && isExecutable(found);
}

/** What runs the script: bash for Claude Code's (it needs it), sh for Codex's, Windows PowerShell on Windows. */
export function interpreter(cli: InstallableCli, file: string, platform: Platform = process.platform): { bin: string; args: string[] } | null {
  if (platform === "win32") {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    const bin = findOnPath("powershell", [path.join(root, "System32", "WindowsPowerShell", "v1.0")]);
    return bin ? { bin, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file] } : null;
  }
  const bin = findOnPath(cli === "claude" ? "bash" : "sh", ["/bin", "/usr/bin"]);
  return bin ? { bin, args: [file] } : null;
}

const outcome = (status: InstallStatus, message: string): InstallOutcome => ({ status, message });

/**
 * Installs `cli` with its official installer, unless it's already there.
 * Stopping (or quitting) ends the installer's whole process group.
 */
export async function installCli(cli: CliId, fetcher?: FetchScript): Promise<InstallOutcome> {
  if (!isInstallable(cli)) return outcome("unsupported", `${cliName(cli)} has no installer Phaethon can run. Install it with npm, then check again.`);
  if (installed(cli)) return outcome("installed", `${cliName(cli)} is already installed.`);
  fetcher ??= localScript(cli) ?? fetchScript;
  const run = claim(installRunKey(cli));
  if (!run) return outcome("busy", `${cliName(cli)} is already being installed.`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-install-"));
  try {
    return await runInstaller(cli, fetcher, run, dir);
  } finally {
    release(run);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runInstaller(cli: InstallableCli, fetcher: FetchScript, run: Run, dir: string): Promise<InstallOutcome> {
  const name = cliName(cli);
  let script: string;
  try {
    script = await fetcher(cli, process.platform, run.abort.signal);
  } catch (e) {
    if (run.abort.signal.aborted) return outcome("cancelled", `Installing ${name} was stopped.`);
    return outcome("failed", (e as Error).message);
  }
  const file = path.join(dir, process.platform === "win32" ? "install.ps1" : "install.sh");
  fs.writeFileSync(file, script, { mode: 0o600 });
  const how = interpreter(cli, file);
  if (!how) return outcome("failed", process.platform === "win32" ? "Windows PowerShell wasn’t found, so the installer can’t run." : "No shell was found to run the installer.");

  // The installers put the CLI under the home Phaethon looks in, and must never stop to ask.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir(), CODEX_NON_INTERACTIVE: "1" };
  let gc;
  try {
    gc = await spawnInGroup(how.bin, how.args, { cwd: dir, env, run, stdin: "ignore", cli });
  } catch (e) {
    return outcome("failed", `${name}’s installer couldn’t start: ${(e as Error).message}`);
  }
  let said = "";
  const hear = (d: Buffer) => {
    said += d.toString("utf8");
    if (said.length > 64 * 1024) said = said.slice(-48 * 1024);
  };
  gc.stdout.on("data", hear);
  gc.child.stderr?.on("data", hear);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), INSTALL_WAIT_MS)));
  const done = await Promise.race([gc.exited.then(() => "done" as const), abortion(run.abort.signal), timedOut]);
  clearTimeout(timer);
  if (done !== "done") {
    await stopGroup(gc, run);
    return done === "abort" ? outcome("cancelled", `Installing ${name} was stopped.`) : outcome("failed", `${name}’s installer took too long. Try again.`);
  }
  const exit = await gc.exited;
  await stopGroup(gc, run);
  if (exit.code !== 0) {
    // ANSI colour codes from the installers' messages.
    const why = stderrSummary(said.replace(/\u001b\[[0-9;]*m/g, ""));
    return outcome("failed", why ? `${name} couldn’t be installed: ${why}` : `${name} couldn’t be installed. Try again.`);
  }
  return installed(cli) ? outcome("installed", `${name} is installed.`) : outcome("failed", `${name}’s installer finished, but Phaethon can’t find ${cli} yet. Check again in a moment.`);
}
