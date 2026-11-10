// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// (ProviderInstanceConfig, managed homes, and codexRateLimitsToWindows via the Rust port.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeDir } from "../env.ts";
import { writeFileAtomic } from "../core/fsx.ts";
import { appFiles, vaultName } from "../core/vault.ts";
import { Refusal } from "../rpc/registry.ts";
import { readSettings, updateSettings } from "../settings/settings.ts";
import { CLI, CLI_IDS, cliName, cliOfBackend, isCliId, type CliId } from "./cli.ts";
import { childPath, commonBinDirs, findBinary, findOnPath, isExecutable, readLines, scrubbedEnv, spawnInGroup, stopGroup, exitWithin } from "./process.ts";

/**
 * Instances ("connections"): named launch configurations for one CLI
 * account, each with its own config home so credentials stay apart. Three
 * kinds: built-in (one per CLI), named (saved by the person) and system
 * (computed from an existing `~/.codex` or `~/.gemini`, never saved).
 * Credentials are never read: account state comes only from what the CLIs print.
 */

export type Instance = { id: string; cli: string; name: string; binary: string; args: string[] };

export type InstanceView = {
  config: Instance;
  installed: boolean;
  loggedIn: boolean | null;
  account: string | null;
  plan: string | null;
  selected: boolean;
  managedHome: boolean;
  source: "system" | "managed";
  readOnly: boolean;
};

export const SYSTEM_IDS = ["codex-system", "gemini-system"] as const;
const isSystemId = (id: string) => (SYSTEM_IDS as readonly string[]).includes(id);

/** `<appData>/claude-config`, where every per-vault CLI home lives. */
export function configRoot(): string {
  return appFiles.claudeConfigRoot();
}

export function cliOf(id: string): CliId {
  if (!isCliId(id)) throw new Refusal("Unknown assistant.");
  return id;
}

function builtIn(cli: CliId): Instance {
  return { id: cli, cli, name: cliName(cli), binary: "", args: [] };
}

function systemInstance(id: string): Instance | null {
  const cli: CliId | null = id === "codex-system" ? "codex" : id === "gemini-system" ? "gemini" : null;
  return cli ? { id, cli, name: `${cliName(cli)} · System`, binary: "", args: [] } : null;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function systemHome(id: string): string | null {
  const home = homeDir();
  if (!home) return null;
  if (id === "codex-system") return isDir(path.join(home, ".codex")) ? path.join(home, ".codex") : null;
  // GEMINI_CLI_HOME is the parent of `.gemini`, not the folder itself.
  if (id === "gemini-system") return isDir(path.join(home, ".gemini")) ? home : null;
  return null;
}

const MANAGED_ARGS = ["--output-format", "--input-format", "--resume", "--session-id", "--print", "-p", "--json", "--help", "--version"];

export function validate(i: Instance): void {
  if (isSystemId(i.id)) throw new Refusal("System CLI configuration is computed from its existing home.");
  cliOf(i.cli);
  if (CLI_IDS.some((c) => c === i.id && c !== i.cli)) throw new Refusal("The built-in assistant identifier belongs to another assistant.");
  if (!i.id || Buffer.byteLength(i.id) > 96 || !/^[A-Za-z0-9-]+$/.test(i.id)) throw new Refusal("Invalid assistant instance.");
  if (!i.name.trim() || [...i.name].length > 80) throw new Refusal("Use a name of 1–80 characters.");
  if (Buffer.byteLength(i.binary) > 4096 || i.binary.includes("\0")) throw new Refusal("Invalid executable path.");
  if (i.args.length > 64 || i.args.some((a) => Buffer.byteLength(a) > 4096 || a.includes("\0") || a.includes("\n"))) {
    throw new Refusal("Use at most 64 single-line arguments.");
  }
  if (i.args.some((a) => MANAGED_ARGS.some((flag) => a === flag || a.startsWith(`${flag}=`)))) {
    throw new Refusal("Output, session and prompt arguments are managed by Phaethon.");
  }
}

function isValid(i: Instance): boolean {
  try {
    validate(i);
    return true;
  } catch {
    return false;
  }
}

/** One saved entry as serde read it: id, cli and name strings; binary and args optional. */
function parseInstance(v: unknown): Instance | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.cli !== "string" || typeof o.name !== "string") return null;
  if (o.binary !== undefined && typeof o.binary !== "string") return null;
  if (o.args !== undefined && !(Array.isArray(o.args) && o.args.every((a) => typeof a === "string"))) return null;
  return { id: o.id, cli: o.cli, name: o.name, binary: (o.binary as string | undefined) ?? "", args: (o.args as string[] | undefined) ?? [] };
}

function activeSelection(): Record<string, unknown> | null {
  const v = readSettings().activeAgentInstances;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function list(): Instance[] {
  const instances = CLI_IDS.map(builtIn);
  const raw = readSettings().agentInstances;
  if (Array.isArray(raw)) {
    const parsed = raw.map(parseInstance);
    // One entry that doesn't parse voids the whole saved list, as before.
    if (parsed.every((p) => p !== null)) {
      for (const instance of parsed as Instance[]) {
        if (isSystemId(instance.id) || !isValid(instance)) continue;
        const at = instances.findIndex((i) => i.id === instance.id);
        if (at >= 0) instances[at] = instance;
        else instances.push(instance);
      }
    }
  }
  const active = activeSelection();
  for (const id of SYSTEM_IDS) {
    const config = systemInstance(id)!;
    // A missing selected home stays listed (and unavailable); it never becomes another account.
    if (active?.[config.cli] === id || systemHome(id) !== null) instances.push(config);
  }
  return instances;
}

export function selected(cli: CliId): Instance {
  const chosen = activeSelection()?.[cli];
  const id = typeof chosen === "string" ? chosen : cli;
  return list().find((i) => i.id === id && i.cli === cli) ?? builtIn(cli);
}

export function find(id: string): Instance {
  const instance = list().find((i) => i.id === id);
  if (!instance) throw new Refusal("Assistant instance not found.");
  return instance;
}

export function home(instance: Instance): string | null {
  if (!isCliId(instance.cli)) return null;
  const cli = instance.cli;
  const system = systemInstance(instance.id);
  if (system) return system.cli === instance.cli ? systemHome(instance.id) : null;
  const root = configRoot();
  if (instance.id === cli) {
    if (!CLI[cli].ownHome && !readSettings().isolateClaudeConfig) return null;
    return cli === "claude" ? path.join(root, vaultName()) : path.join(root, `${vaultName()}-${cli}`);
  }
  return path.join(root, `${vaultName()}-instance-${instance.id}`);
}

export function requireHome(instance: Instance): string | null {
  const dir = home(instance);
  if (dir === null && instance.id !== instance.cli) throw new Refusal("Phaethon cannot find a local configuration folder for this connection.");
  return dir;
}

/** The selected instance's home for `cli` (the turn's, the status probes' and the import's config dir). */
export function configDirFor(cli: CliId): string | null {
  try {
    return requireHome(selected(cli));
  } catch {
    return null;
  }
}

export function save(input: unknown): Instance {
  const parsed = parseInstance(input);
  if (!parsed) throw new Refusal("Invalid assistant instance.");
  if (isSystemId(parsed.id)) throw new Refusal("System CLI connections are managed by their CLI. Add a separate connection to customize a launch.");
  const instance = { ...parsed, name: parsed.name.trim(), binary: parsed.binary.trim() };
  validate(instance);
  requireHome(instance);
  const all = list();
  const at = all.findIndex((i) => i.id === instance.id);
  if (at >= 0) {
    if (all[at].cli !== instance.cli) throw new Refusal("An instance cannot change assistant type.");
    all[at] = instance;
  } else all.push(instance);
  const kept = all.filter((i) => !isSystemId(i.id));
  const dir = home(instance);
  if (dir !== null) {
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, "phaethon-instance.json"), JSON.stringify(instance));
  } else if (instance.binary || instance.args.length) {
    throw new Refusal("Add a named Claude Code instance to customize its launch options.");
  }
  updateSettings({ agentInstances: kept });
  return instance;
}

export function select(id: string): void {
  const instance = find(id);
  const current = activeSelection() ?? {};
  updateSettings({ activeAgentInstances: { ...current, [instance.cli]: id }, backend: `${instance.cli as CliId}-cli` });
}

export function remove(id: string): void {
  if (isSystemId(id) || CLI_IDS.some((c) => c === id)) throw new Refusal("Built-in assistants cannot be removed.");
  updateSettings({ agentInstances: list().filter((i) => i.id !== id && !isSystemId(i.id)) });
}

/** The instance a home belongs to: a system home's computed one, or the home's `phaethon-instance.json` if valid. */
export function launch(dir: string | null): Instance | null {
  if (!dir) return null;
  for (const id of SYSTEM_IDS) if (systemHome(id) === dir) return systemInstance(id);
  try {
    const value = parseInstance(JSON.parse(fs.readFileSync(path.join(dir, "phaethon-instance.json"), "utf8")));
    return value && isValid(value) ? value : null;
  } catch {
    return null;
  }
}

/** The binary a run uses: the instance's own if it names one, else the installed CLI. */
export function binary(cli: CliId, dir: string | null): string | null {
  const instance = launch(dir);
  if (instance && instance.cli === cli && instance.binary) {
    if (path.isAbsolute(instance.binary)) return isExecutable(instance.binary) ? instance.binary : null;
    return findOnPath(instance.binary, commonBinDirs());
  }
  return findBinary(cli);
}

/** How the session of a non-built-in instance is tagged in `.phaethon/session`; the CLI's own tag otherwise. */
export function sessionTag(cli: CliId, dir: string | null): string | null {
  const instance = launch(dir);
  if (instance && instance.id !== cli) return `${cli}-${instance.id}`;
  return CLI[cli].sessionTag;
}

/** Where Codex or Gemini CLI is pointed when there's no home for it: an empty one, never the person's. */
export function noHome(): string {
  return path.join(os.tmpdir(), "phaethon-no-cli-home");
}

export type CliCommand = { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

/**
 * The spawn recipe every CLI process uses (turns, probes, sign-in, sign-out):
 * the instance's binary and arguments first, credential variables removed for
 * named and system accounts, the parent session's variables removed, PATH
 * extended for Codex and Gemini, and the setup folder variable.
 */
export function cliCommand(cli: CliId, bin: string, cwd: string, configDir: string | null): CliCommand {
  const instance = launch(configDir);
  const own = instance && instance.cli === cli ? instance : null;
  const file = (own?.binary ? binary(cli, configDir) : null) ?? bin;
  const env = scrubbedEnv(cli);
  if (own && own.id !== cli) for (const name of CLI[cli].credentialVars) delete env[name];
  // The binary actually run (an instance may name its own), so a JavaScript CLI finds its `node`.
  if (cli !== "claude") env.PATH = childPath(file);
  const dir = configDir ?? (CLI[cli].ownHome ? noHome() : null);
  if (dir) {
    if (CLI[cli].ownHome) {
      try {
        // Codex refuses a CODEX_HOME that isn't there.
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // reported by the CLI
      }
    }
    env[CLI[cli].configVar] = dir;
  }
  return { file, args: own ? [...own.args] : [], cwd, env };
}

export type Collected = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

/** Runs one short CLI command (status, sign-out) to completion or `timeoutMs`, then ends its whole group. */
export async function collect(cmd: CliCommand, args: string[], timeoutMs: number): Promise<Collected | null> {
  let gc;
  try {
    gc = await spawnInGroup(cmd.file, [...cmd.args, ...args], { cwd: cmd.cwd, env: cmd.env, stdin: "ignore" });
  } catch {
    return null;
  }
  let stdout = "";
  gc.stdout.setEncoding("utf8");
  gc.stdout.on("data", (d: string) => {
    if (stdout.length < 4 * 1024 * 1024) stdout += d;
  });
  const done = await exitWithin(gc, timeoutMs);
  const stderr = done ? await gc.stderrText(500) : "";
  const exit = await stopGroup(gc);
  return { code: done ? exit.code : null, stdout, stderr, timedOut: !done };
}

export function parseCodexLogin(said: string): boolean | null {
  if (said.includes("Not logged in")) return false;
  if (said.includes("Logged in")) return true;
  return null;
}

/** `codex login status`, read for its words; unknown when it says neither or takes over 5 s. */
export async function codexLoggedIn(bin: string, dir: string | null): Promise<boolean | null> {
  const out = await collect(cliCommand("codex", bin, os.tmpdir(), dir), ["login", "status"], 5000);
  if (!out || out.timedOut) return null;
  return parseCodexLogin(out.stdout + out.stderr);
}

/** Public account status only (`claude auth status --json`); no credential files or tokens are read. */
export async function account(cli: CliId, dir: string | null): Promise<{ loggedIn: boolean | null; email: string | null; plan: string | null }> {
  const none = { loggedIn: null, email: null, plan: null };
  const bin = binary(cli, dir);
  if (!bin) return none;
  if (cli === "codex") return { ...none, loggedIn: await codexLoggedIn(bin, dir) };
  if (cli !== "claude") return none;
  const out = await collect(cliCommand(cli, bin, os.tmpdir(), dir), ["auth", "status", "--json"], 8000);
  if (!out || out.timedOut) return none;
  try {
    const v = JSON.parse(out.stdout);
    return {
      loggedIn: typeof v.loggedIn === "boolean" ? v.loggedIn : null,
      email: typeof v.email === "string" ? v.email : null,
      plan: typeof v.subscriptionType === "string" ? v.subscriptionType : null,
    };
  } catch {
    return none;
  }
}

export async function views(): Promise<InstanceView[]> {
  const settings = readSettings();
  const out: InstanceView[] = [];
  for (const config of list()) {
    if (!isCliId(config.cli)) continue;
    const cli = config.cli;
    const dir = home(config);
    let homeOk = true;
    try {
      requireHome(config);
    } catch {
      homeOk = false;
    }
    const installed = homeOk && binary(cli, dir) !== null;
    const acct = installed ? await account(cli, dir) : { loggedIn: null, email: null, plan: null };
    const readOnly = isSystemId(config.id);
    const system = readOnly || (cli === "claude" && config.id === cli && !settings.isolateClaudeConfig);
    out.push({
      config,
      installed,
      loggedIn: acct.loggedIn,
      account: acct.email,
      plan: acct.plan,
      selected: selected(cli).id === config.id && cliOfBackend(settings.backend) === cli,
      managedHome: dir !== null && !system,
      source: system ? "system" : "managed",
      readOnly,
    });
  }
  return out;
}

export async function signOut(cli: CliId, dir: string | null): Promise<void> {
  if (cli === "gemini") throw new Refusal("Use Gemini CLI to sign out of this account.");
  const bin = binary(cli, dir);
  if (!bin) throw new Refusal("Assistant executable not found.");
  const out = await collect(cliCommand(cli, bin, os.tmpdir(), dir), cli === "claude" ? ["auth", "logout"] : ["logout"], 15000);
  if (!out) throw new Refusal("The assistant did not finish signing out.");
  if (out.timedOut) throw new Refusal("Sign-out timed out.");
  if (out.code !== 0) throw new Refusal("The assistant did not finish signing out.");
}

// ---- Usage (T3's Claude get_usage and Codex account/rateLimits/read probes; no turn is ever started) ----

export type UsageWindow = { label: string; usedPercent: number; resetsAt: string | number | null };
export type Usage = { available: boolean; windows: UsageWindow[]; reason: string | null };

function unavailable(reason: string): Usage {
  return { available: false, windows: [], reason };
}

const clamp = (n: number) => Math.min(100, Math.max(0, n));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function parseUsage(cli: CliId, value: unknown): UsageWindow[] {
  if (cli === "codex") return codexUsageWindows(value);
  const out: UsageWindow[] = [];
  const limits = obj(obj(value).rate_limits);
  for (const [key, label] of [
    ["five_hour", "5 hours"],
    ["seven_day", "7 days"],
    ["seven_day_sonnet", "Sonnet · 7 days"],
  ] as const) {
    const w = obj(limits[key]);
    if (!finite(w.utilization)) continue;
    out.push({ label, usedPercent: clamp(w.utilization), resetsAt: typeof w.resets_at === "string" ? w.resets_at : null });
  }
  return out;
}

function codexResetAt(w: Record<string, unknown>): number | null {
  return typeof w.resetsAt === "number" && Number.isInteger(w.resetsAt) && w.resetsAt > 0 ? w.resetsAt : null;
}

function codexUsageWindows(value: unknown): UsageWindow[] {
  const v = obj(value);
  const byId = obj(v.rateLimitsByLimitId).codex;
  const snapshot = byId && typeof byId === "object" && !Array.isArray(byId) ? obj(byId) : obj(v.rateLimits);
  if (typeof snapshot.limitId === "string" && snapshot.limitId !== "codex") return [];
  const monthly = snapshot.planType === "free" || snapshot.planType === "go";
  const out: UsageWindow[] = [];
  for (const [key, fallback] of [
    ["primary", monthly ? 43200 : 300],
    ["secondary", 10080],
  ] as const) {
    const w = obj(snapshot[key]);
    if (!finite(w.usedPercent)) continue;
    const mins = finite(w.windowDurationMins) && w.windowDurationMins > 0 ? w.windowDurationMins : fallback;
    const label = mins >= 43200 ? "Monthly" : mins >= 10080 ? "Weekly" : "Session";
    out.push({ label, usedPercent: clamp(w.usedPercent), resetsAt: codexResetAt(w) });
  }
  const credit = obj(snapshot.individualLimit);
  if (finite(credit.remainingPercent)) out.push({ label: "Monthly credit limit", usedPercent: clamp(100 - credit.remainingPercent), resetsAt: codexResetAt(credit) });
  return out;
}

export async function usage(cli: CliId, dir: string | null): Promise<Usage> {
  if (cli === "gemini") return unavailable("Gemini CLI does not expose account limits.");
  const bin = binary(cli, dir);
  if (!bin) return unavailable("Assistant executable not found.");
  const cmd = cliCommand(cli, bin, os.tmpdir(), dir);
  const args =
    cli === "claude"
      ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"]
      : ["app-server"];
  const requests =
    cli === "claude"
      ? [
          { type: "control_request", request_id: "phaethon-init", request: { subtype: "initialize" } },
          { type: "control_request", request_id: "phaethon-usage", request: { subtype: "get_usage", skipBehaviors: true } },
        ]
      : [
          { id: 1, method: "initialize", params: { clientInfo: { name: "phaethon", version: "0.1.2" }, capabilities: { experimentalApi: true } } },
          { method: "initialized", params: {} },
          { id: 2, method: "account/rateLimits/read", params: null },
        ];
  const result = await probeLines(cmd, args, requests.map((r) => JSON.stringify(r)), 20000, 100, (v) => {
    if (cli === "claude") {
      const response = obj(obj(v).response);
      return response.request_id === "phaethon-usage" ? { value: response.response } : undefined;
    }
    return obj(v).id === 2 ? { value: obj(v).result } : undefined;
  });
  if (result === undefined || result === null) return unavailable("Usage is unavailable. Refresh to try again.");
  const windows = parseUsage(cli, result);
  return windows.length ? { available: true, windows, reason: null } : unavailable("This account does not report usage windows.");
}

/**
 * Starts a CLI, writes `lines` to its stdin, and reads at most `maxLines`
 * JSON lines (each under 1 MiB) until `pick` returns something; then ends the
 * whole group. Undefined on timeout, a failed start or no answer.
 */
export async function probeLines(
  cmd: CliCommand,
  args: string[],
  lines: string[],
  timeoutMs: number,
  maxLines: number,
  pick: (v: unknown) => { value: unknown } | undefined,
  extraEnv: Record<string, string> = {},
  maxBytes = 2 * 1024 * 1024,
): Promise<unknown> {
  let gc;
  try {
    gc = await spawnInGroup(cmd.file, [...cmd.args, ...args], { cwd: cmd.cwd, env: { ...cmd.env, ...extraEnv } });
  } catch {
    return undefined;
  }
  gc.child.stderr?.resume();
  for (const line of lines) gc.stdin?.write(`${line}\n`);
  let seen = 0;
  let bytes = 0;
  let found: { value: unknown } | undefined;
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  const reading = readLines(
    gc.stdout,
    (line) => {
      if (found) return;
      bytes += line.length + 1;
      if (++seen > maxLines || line.length > 1024 * 1024 || bytes > maxBytes) {
        finish();
        return;
      }
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        return;
      }
      found = pick(v);
      if (found) finish();
    },
    maxBytes,
  );
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([finished, reading, new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))]);
  clearTimeout(timer);
  await stopGroup(gc, undefined, 200);
  return found?.value;
}
