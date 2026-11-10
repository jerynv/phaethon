import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBinary, spawnInGroup, stopGroup, type GroupChild } from "../cli/process.ts";
import type { CliId as Cli } from "../cli/cli.ts";
import { cliCommand } from "../cli/instances.ts";
import { appFiles, spaceDir, vaultName } from "../core/vault.ts";
import { homeDir } from "../env.ts";
import { completeSeesPictures, completeText } from "../providers/complete.ts";
import type { Block } from "../core/thread.ts";
import { Refusal } from "../rpc/registry.ts";
import { readSettings, type VaultSettings } from "../settings/settings.ts";
import { readSpaceMeta } from "../spaces/meta.ts";
import type { Picture } from "./types.ts";

/**
 * One way to ask a model a single question, for everything in Study that
 * needs one (making cards and quizzes, grading short answers, reviewing
 * mistakes, mapping a course). Port of `study/model.rs`.
 *
 * - Phaethon's own provider (through `completeText`) when Phaethon's agent
 *   is chosen; the key never leaves the core.
 * - Otherwise the official CLI the person installed and signed into, as a
 *   one-shot call with no tools, no session kept and none of their own setup
 *   loaded. Phaethon never reads or passes its credentials.
 *
 * Every rejection is a message for the person (a plain string).
 */

export interface Model {
  complete(system: string, user: string): Promise<string>;
  /** Whether `completeSeeing` really shows it pictures. */
  showsPictures(): boolean;
  /** Ask with `pictures` alongside the question; a model that can't see is asked without. */
  completeSeeing(system: string, user: string, pictures: Picture[]): Promise<string>;
}

/** Checks a JSON reply; throws a string saying what's wrong with it. */
export type Validate<T> = (v: unknown) => T;

export const NO_MODEL = "No model is set up: add an API key in Settings, or switch to Claude Code.";
export const MISSING_CLI_MESSAGE = "Claude Code was not found. Install it, then connect it in Settings › Assistant.";
export const NOT_LOGGED_IN_MESSAGE = "Claude Code isn’t signed in. Sign in to this connection in Settings › Assistant, then retry.";
/** Longest a single CLI call may take. */
export const CLI_TIMEOUT_MS = 600_000;
/** Most of a CLI's stdout kept. */
export const CLI_OUTPUT_MAX = 8 * 1024 * 1024;
const STDERR_MAX = 64 * 1024;

const NAMES: Record<Cli, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };
const MISSING: Record<Cli, string> = {
  claude: MISSING_CLI_MESSAGE,
  codex: "Codex was not found. Install Codex, then sign in to it in Settings › Assistant.",
  gemini: "Gemini CLI was not found. Install Gemini CLI, then sign in to it in Settings › Assistant.",
};
const UNSUPPORTED_REASONING = "That assistant does not support this reasoning level.";

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

// ---- Phaethon's own provider ------------------------------------------------------

/**
 * Phaethon's own provider, asked once with no tools. `completeText` has no
 * image input yet, so this model is never shown pictures.
 * TODO(agent worker): when completeText reports stop reasons, map "refusal" to
 * "The model declined to do this with this material." and an empty
 * "max_tokens" answer to "The answer was cut off before it began. Try fewer
 * cards or questions." (model.rs ProviderModel::ask).
 */
export class ApiModel implements Model {
  constructor(
    readonly space: string,
    readonly model: string | undefined,
    private readonly signal?: AbortSignal,
    /** Asked instead when no provider is set up (Rust: Claude Code when installed). */
    private readonly fallback?: () => Model | null,
  ) {}

  async complete(system: string, user: string, pictures: Picture[] = []): Promise<string> {
    try {
      // Mapping, writing items with their derivations and judging them are all reasoning work.
      const content = pictures.length ? (pictureBlocks(user, pictures) as Block[]) : user;
      const req: Parameters<typeof completeText>[0] = { space: this.space, system, messages: [{ role: "user", content }], effort: "high" };
      if (this.model) req.model = this.model;
      if (this.signal) req.signal = this.signal;
      return (await completeText(req)).text;
    } catch (e) {
      const m = errText(e);
      if (e instanceof Refusal && (m === NO_MODEL || /\bkey\b/i.test(m))) {
        const other = this.fallback?.();
        if (other) return other.complete(system, user);
      }
      throw m;
    }
  }

  showsPictures(): boolean {
    const req: { space: string; model?: string } = { space: this.space };
    if (this.model) req.model = this.model;
    return completeSeesPictures(req);
  }

  completeSeeing(system: string, user: string, pictures: Picture[]): Promise<string> {
    return this.complete(system, user, this.showsPictures() ? pictures : []);
  }
}

/** A message's content: each picture after a line naming it, then the question. */
export function pictureBlocks(user: string, pictures: Picture[]): unknown[] {
  const content: unknown[] = [];
  for (const p of pictures) {
    content.push({ type: "text", text: `Picture: ${p.label}` });
    content.push({ type: "image", source: { type: "base64", media_type: p.mime, data: p.data } });
  }
  content.push({ type: "text", text: user });
  return content;
}

// ---- CLI helpers ------------------------------------------------------------------

/** `is_valid_cli_model`: the compat-model rule, at most 100 bytes. */
export function isValidCliModel(id: string): boolean {
  return (
    id.length > 0 &&
    Buffer.byteLength(id) <= 100 &&
    !/^[-./:]/.test(id) &&
    !id.includes("..") &&
    /^[A-Za-z0-9\-_.:/@+]+$/.test(id)
  );
}

export function validReasoning(cli: string, effort: string): boolean {
  if (cli === "claude") return ["low", "medium", "high", "xhigh", "max"].includes(effort);
  if (cli === "codex") return ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort);
  return false;
}

function reasoningArgs(cli: Cli, args: string[], reasoning: string | null | undefined): void {
  if (reasoning == null) return;
  if (!validReasoning(cli, reasoning)) throw UNSUPPORTED_REASONING;
  if (cli === "claude") args.push("--effort", reasoning);
  else if (cli === "codex") args.splice(1, 0, "-c", `model_reasoning_effort="${reasoning}"`);
}

/** The last error-looking stderr line, skipping stack frames. */
export function stderrSummary(s: string): string {
  const lines = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("at "));
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.includes("Error") || lines[i]!.includes("error")) return lines[i]!;
  return lines[lines.length - 1] ?? "";
}

function notLoggedIn(cli: Cli, s: string): boolean {
  if (cli === "claude") return s.includes("Not logged in") || s.includes("/login");
  if (cli === "codex") return s.includes("401 Unauthorized") || s.includes("Not logged in") || s.includes("Missing bearer");
  return s.includes("FatalAuthenticationError") || s.includes("Please set an Auth method") || s.includes("must specify the GEMINI_API_KEY");
}

function notLoggedInMessage(cli: Cli, configDir: string | null): string {
  if (cli === "claude" && !configDir) return NOT_LOGGED_IN_MESSAGE;
  if (cli !== "claude") return `${NAMES[cli]} isn’t signed in for this Phaethon folder yet. Sign in to it in Settings › Assistant, then send your message again.`;
  return `${NAMES[cli]} isn’t signed in. Sign in to this connection in Settings › Assistant, then retry.`;
}

/** Arguments for a one-shot Claude Code call: print mode, one JSON result, no tools, none of the person's setup, no session. */
export function cliArgs(system: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--restricted",
    "--strict-mcp-config",
    "--no-chrome",
    "--safe-mode",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt",
    system,
  ];
}

/** `cliArgs` for a question with pictures: stream-json in and out. */
export function cliArgsSeeing(system: string): string[] {
  const args = cliArgs(system);
  const i = args.indexOf("--output-format");
  if (i >= 0) args[i + 1] = "stream-json";
  args.splice(1, 0, "--input-format", "stream-json", "--verbose");
  return args;
}

/** The stdin line for `cliArgsSeeing`. */
export function cliMessage(user: string, pictures: Picture[]): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: pictureBlocks(user, pictures) } }) + "\n";
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The answer text from `claude -p --output-format json` (one result, or an array/lines of events ending with it). */
export function parseCliOutput(stdout: string): string {
  const trimmed = stdout.trim();
  const v = tryJson(trimmed);
  let r: Record<string, unknown> | undefined;
  if (Array.isArray(v)) r = [...v].reverse().find((e) => isObj(e) && e.type === "result") as Record<string, unknown> | undefined;
  else if (isObj(v)) r = v;
  else {
    const lines = trimmed === "" ? [] : trimmed.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    for (let i = lines.length - 1; i >= 0; i--) {
      const e = tryJson(lines[i]!);
      if (isObj(e) && e.type === "result") {
        r = e;
        break;
      }
    }
  }
  if (!r) {
    if (trimmed === "") throw "Claude Code didn’t answer.";
    return trimmed;
  }
  const text = typeof r.result === "string" ? r.result : "";
  const failed = r.is_error === true || (typeof r.subtype === "string" && r.subtype !== "success");
  if (failed) {
    if (text.includes("Not logged in") || text.includes("/login")) throw NOT_LOGGED_IN_MESSAGE;
    const sub = typeof r.subtype === "string" ? r.subtype : "error";
    throw text === "" ? `Claude Code stopped: ${sub}.` : `Claude Code said: ${text}`;
  }
  return text;
}

/** The answer text from `codex exec --json` or `gemini --output-format json`. */
export function parseOtherOutput(cli: Cli, stdout: string): string {
  const name = NAMES[cli];
  const lines = stdout === "" ? [] : stdout.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (cli === "codex") {
    const text: string[] = [];
    for (const l of lines) {
      const v = tryJson(l);
      if (!isObj(v)) continue;
      const item = isObj(v.item) ? v.item : {};
      if (v.type === "item.completed" && item.type === "agent_message") text.push(typeof item.text === "string" ? item.text : "");
      else if (v.type === "turn.failed") {
        const err = isObj(v.error) ? v.error : {};
        throw `${name} said: ${typeof err.message === "string" ? err.message : "it stopped"}`;
      }
    }
    const joined = text.join("\n\n");
    if (joined.trim() === "") throw `${name} didn’t answer.`;
    return joined;
  }
  let found: Record<string, unknown> | undefined;
  for (const l of [...lines.reverse(), stdout]) {
    const v = tryJson(l.trim());
    if (isObj(v) && ("response" in v || "error" in v)) {
      found = v;
      break;
    }
  }
  if (!found) throw `${name} didn’t answer.`;
  if (found.error !== undefined && found.error !== null) {
    const err = isObj(found.error) ? found.error : {};
    throw `${name} said: ${typeof err.message === "string" ? err.message : "it stopped"}`;
  }
  return typeof found.response === "string" ? found.response : "";
}

/** Codex's arguments with `files` attached (`--image=<file>` each, before the stdin marker). */
export function withImages(args: string[], files: string[]): string[] {
  const out = [...args];
  const at = out[out.length - 1] === "-" ? out.length - 1 : out.length;
  out.splice(at, 0, ...files.map((f) => `--image=${f}`));
  return out;
}

const DISABLED_FEATURES = [
  "plugins",
  "apps",
  "multi_agent",
  "goals",
  "view_image",
  "memories",
  "hooks",
  "tool_suggest",
  "skill_search",
  "computer_use",
  "browser_use",
  "in_app_browser",
  "image_generation",
];

const tomlStr = (s: string): string => JSON.stringify(s);

function codexBaseArgs(cwd: string, readable: string[], model: string | null): string[] {
  const args = ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--cd", cwd];
  if (model) args.push("-m", model);
  const roots = ['":minimal"="read"', ...readable.map((p) => `${tomlStr(p)}="read"`)];
  for (const c of [
    'approval_policy="never"',
    'web_search="disabled"',
    "project_doc_max_bytes=0",
    "skills.include_instructions=false",
    "skills.bundled.enabled=false",
    'default_permissions="phaethon"',
    `permissions.phaethon.filesystem={${roots.join(",")}}`,
  ])
    args.push("-c", c);
  for (const f of DISABLED_FEATURES) args.push("--disable", f);
  return args;
}

function codexOwnDirs(bin: string): string[] {
  const dirs = [path.dirname(bin)];
  try {
    const real = fs.realpathSync.native(bin);
    if (real !== bin) dirs.push(path.dirname(path.dirname(real)));
  } catch {
    // not there: nothing more to read
  }
  return dirs;
}

const NO_TOOLS_POLICY = '# Phaethon: no tools.\n[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n';

function geminiPolicyFile(): string {
  const dir = path.join(os.tmpdir(), "phaethon-gemini");
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  const file = path.join(dir, "no-tools.toml");
  const tmp = path.join(dir, `no-tools.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, NO_TOOLS_POLICY);
  fs.renameSync(tmp, file);
  return file;
}

function geminiBaseArgs(policy: string, json: string, model: string | null): string[] {
  const args = ["--output-format", json, "--approval-mode", "plan", "--extensions", "none", "--allowed-mcp-server-names", "phaethon-none", "--admin-policy", policy, "--policy", policy];
  if (model) args.push("--model", model);
  return args;
}

type Ran = { stdout: string; stderr: string; code: number | null };

/** Runs a CLI once with `input` on stdin, under the timeout; cancelling kills its process group. */
async function runOnce(
  cli: Cli,
  bin: string,
  args: string[],
  input: string,
  opts: { cwd: string; configDir: string | null; env?: Record<string, string>; signal?: AbortSignal },
): Promise<Ran> {
  if (opts.signal?.aborted) throw "Stopped.";
  // The CLI's environment (credential variables scrubbed, its config home set) comes from the CLI module.
  const env = { ...cliCommand(cli, bin, opts.cwd, opts.configDir).env, ...(opts.env ?? {}) };
  // The group wrapper starts even when the CLI is gone, so look first.
  if (!isExecutable(bin)) throw MISSING[cli];
  let gc: GroupChild;
  try {
    gc = await spawnInGroup(bin, args, { cwd: opts.cwd, env, input, cli });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw MISSING[cli];
    throw `Could not start ${NAMES[cli]}: ${errText(e)}`;
  }
  const out: Buffer[] = [];
  let outLen = 0;
  gc.stdout.on("data", (b: Buffer) => {
    if (outLen >= CLI_OUTPUT_MAX) return;
    const keep = b.subarray(0, CLI_OUTPUT_MAX - outLen);
    out.push(keep);
    outLen += keep.length;
  });
  let stopped: string | undefined;
  const stop = (why: string) => {
    if (stopped) return;
    stopped = why;
    void stopGroup(gc);
  };
  const timer = setTimeout(() => stop(`${NAMES[cli]} took too long to answer, so it was stopped. Try fewer cards or questions.`), CLI_TIMEOUT_MS);
  const onAbort = () => stop("Stopped.");
  opts.signal?.addEventListener("abort", onAbort);
  try {
    const exit = await gc.exited;
    const stderr = (await gc.stderrText()).slice(0, STDERR_MAX);
    if (stopped) throw stopped;
    return { stdout: new TextDecoder().decode(Buffer.concat(out)), stderr, code: exit.code };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    gc.dispose();
  }
}

// ---- CLI models -------------------------------------------------------------------

export type CliSetup = {
  bin: string;
  /** Working directory: the space (no tool can read it anyway). */
  cwd: string;
  configDir: string | null;
  /** The space's chosen model and reasoning, captured together for this workflow. */
  model: string | null;
  reasoning: string | null;
  /** The selected connection's own launch arguments, put before Phaethon's. */
  launchArgs?: string[];
  signal?: AbortSignal;
};

/** The Claude Code CLI, one call per question. */
export class CliModel implements Model {
  constructor(readonly setup: CliSetup) {}

  private async ask(args: string[], input: string): Promise<string> {
    const s = this.setup;
    if (s.model !== null) {
      if (!isValidCliModel(s.model)) throw "Invalid model name.";
      args.push("--model", s.model);
    }
    reasoningArgs("claude", args, s.reasoning);
    const ran = await runOnce("claude", s.bin, [...(s.launchArgs ?? []), ...args], input, {
      cwd: s.cwd,
      configDir: s.configDir,
      ...(s.signal ? { signal: s.signal } : {}),
    });
    try {
      return parseCliOutput(ran.stdout);
    } catch (e) {
      if (ran.stderr.includes("Not logged in") || ran.stderr.includes("/login")) throw NOT_LOGGED_IN_MESSAGE;
      if (ran.stdout.trim() === "") {
        const lines = ran.stderr.split("\n").map((l) => l.trim());
        const last = [...lines].reverse().find((l) => l !== "");
        if (last !== undefined) throw `Claude Code stopped: ${last}`;
        if (ran.code !== null && ran.code !== 0) throw `Claude Code exited with status ${ran.code}.`;
      }
      throw e;
    }
  }

  complete(system: string, user: string): Promise<string> {
    return this.ask(cliArgs(system), user);
  }

  showsPictures(): boolean {
    return true;
  }

  completeSeeing(system: string, user: string, pictures: Picture[]): Promise<string> {
    if (!pictures.length) return this.complete(system, user);
    return this.ask(cliArgsSeeing(system), cliMessage(user, pictures));
  }
}

let pictureRun = 0;

/** Codex or Gemini CLI, one call per question, with no tools that run anything. */
export class OtherCliModel implements Model {
  constructor(
    readonly cli: Cli,
    readonly setup: CliSetup,
  ) {}

  /** The arguments for one question and what goes on stdin. */
  invocation(system: string, user: string): [string[], string] {
    const { model } = this.setup;
    if (model !== null && !isValidCliModel(model)) throw "Invalid model name.";
    let args: string[];
    let input: string;
    if (this.cli === "codex") {
      args = codexBaseArgs(this.setup.cwd, codexOwnDirs(this.setup.bin), model);
      args.splice(1, 0, "--ephemeral");
      for (const f of ["shell_tool", "unified_exec"]) args.push("--disable", f);
      args.push("-c", `developer_instructions=${tomlStr(system)}`, "-");
      input = user;
    } else if (this.cli === "gemini") {
      let policy: string;
      try {
        policy = geminiPolicyFile();
      } catch (e) {
        throw `Phaethon couldn’t prepare Gemini CLI’s rules: ${errText(e)}`;
      }
      args = geminiBaseArgs(policy, "json", model);
      const message = user.startsWith("/") ? ` ${user}` : user;
      input = `<instructions>\n${system}\n</instructions>\n\n${message}`;
    } else throw "Claude Code is asked through CliModel.";
    reasoningArgs(this.cli, args, this.setup.reasoning);
    return [args, input];
  }

  async complete(system: string, user: string): Promise<string> {
    const [args, input] = this.invocation(system, user);
    return this.run(args, input);
  }

  showsPictures(): boolean {
    return this.cli === "codex";
  }

  async completeSeeing(system: string, user: string, pictures: Picture[]): Promise<string> {
    if (!pictures.length || this.cli !== "codex") return this.complete(system, user);
    const dir = path.join(os.tmpdir(), "phaethon-codex-pictures", `${process.pid}-${pictureRun++}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw `Phaethon couldn’t prepare the pictures for Codex: ${errText(e)}`;
    }
    try {
      const files: string[] = [];
      for (const [i, p] of pictures.entries()) {
        const file = path.join(dir, `picture-${i + 1}.${p.mime === "image/jpeg" ? "jpg" : "png"}`);
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(p.data) || p.data.length % 4 === 1) throw "A picture couldn’t be prepared for Codex.";
        try {
          fs.writeFileSync(file, Buffer.from(p.data, "base64"));
        } catch (e) {
          throw `Phaethon couldn’t prepare the pictures for Codex: ${errText(e)}`;
        }
        files.push(file);
      }
      const labels = pictures.map((p, i) => `Picture ${i + 1}: ${p.label}`);
      const [args, input] = this.invocation(system, `${labels.join("\n")}\n\n${user}`);
      return await this.run(withImages(args, files), input);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private async run(args: string[], input: string): Promise<string> {
    const s = this.setup;
    let cwd = s.cwd;
    const env: Record<string, string> = {};
    if (this.cli === "gemini") {
      cwd = path.join(os.tmpdir(), "phaethon-gemini", "one-shot");
      try {
        fs.mkdirSync(cwd, { recursive: true });
      } catch (e) {
        throw `Phaethon couldn’t prepare a folder for Gemini CLI: ${errText(e)}`;
      }
      env.GEMINI_CLI_TRUST_WORKSPACE = "true";
    }
    const ran = await runOnce(this.cli, s.bin, [...(s.launchArgs ?? []), ...args], input, {
      cwd,
      configDir: s.configDir,
      env,
      ...(s.signal ? { signal: s.signal } : {}),
    });
    try {
      return parseOtherOutput(this.cli, ran.stdout);
    } catch (e) {
      const m = errText(e);
      if (notLoggedIn(this.cli, m) || notLoggedIn(this.cli, ran.stderr)) throw notLoggedInMessage(this.cli, s.configDir);
      if (ran.stdout.trim() === "") {
        const said = stderrSummary(ran.stderr);
        if (said !== "") throw `${NAMES[this.cli]} stopped: ${said}`;
        if (ran.code !== null && ran.code !== 0) throw `${NAMES[this.cli]} exited with status ${ran.code}.`;
      }
      throw m;
    }
  }
}

// ---- Which model a space uses ------------------------------------------------------

type Instance = { id: string; cli: Cli; binary: string; args: string[] };

const CLIS: Cli[] = ["claude", "codex", "gemini"];
const SYSTEM_IDS: Record<string, Cli> = { "codex-system": "codex", "gemini-system": "gemini" };

function cliOfBackend(b: VaultSettings["backend"]): Cli | null {
  return b === "claude-cli" ? "claude" : b === "codex-cli" ? "codex" : b === "gemini-cli" ? "gemini" : null;
}

function savedInstances(settings: VaultSettings): Instance[] {
  const raw = settings.agentInstances;
  if (!Array.isArray(raw)) return [];
  const out: Instance[] = [];
  for (const v of raw) {
    if (!isObj(v) || typeof v.id !== "string" || typeof v.cli !== "string" || typeof v.name !== "string") return [];
    if (v.binary !== undefined && typeof v.binary !== "string") return [];
    if (v.args !== undefined && !(Array.isArray(v.args) && v.args.every((a) => typeof a === "string"))) return [];
    const cli = CLIS.find((c) => c === v.cli);
    if (!cli || v.id in SYSTEM_IDS || !/^[A-Za-z0-9-]{1,96}$/.test(v.id)) continue;
    if ((CLIS as string[]).includes(v.id) && v.id !== cli) continue;
    out.push({ id: v.id, cli, binary: (v.binary as string | undefined) ?? "", args: (v.args as string[] | undefined) ?? [] });
  }
  return out;
}

/** `agent_instances::selected`: the chosen connection for `cli`, else the built-in. */
function selectedInstance(settings: VaultSettings, cli: Cli): Instance {
  const active = isObj(settings.activeAgentInstances) ? settings.activeAgentInstances[cli] : undefined;
  const id = typeof active === "string" ? active : cli;
  if (SYSTEM_IDS[id] === cli) return { id, cli, binary: "", args: [] };
  const saved = savedInstances(settings).find((i) => i.id === id && i.cli === cli);
  return saved ?? { id: cli, cli, binary: "", args: [] };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `agent_instances::home`. */
function instanceHome(settings: VaultSettings, i: Instance): string | null {
  const root = appFiles.claudeConfigRoot();
  if (i.id === "codex-system") return i.cli === "codex" && isDir(path.join(homeDir(), ".codex")) ? path.join(homeDir(), ".codex") : null;
  if (i.id === "gemini-system") return i.cli === "gemini" && isDir(path.join(homeDir(), ".gemini")) ? homeDir() : null;
  if (i.id === i.cli) {
    if (i.cli === "claude") return settings.isolateClaudeConfig ? path.join(root, vaultName()) : null;
    return path.join(root, `${vaultName()}-${i.cli}`);
  }
  return path.join(root, `${vaultName()}-instance-${i.id}`);
}

function requireHome(settings: VaultSettings, i: Instance): string | null {
  const home = instanceHome(settings, i);
  if (home === null && i.id !== i.cli) throw "Phaethon cannot find a local configuration folder for this connection.";
  return home;
}

function findOnPath(name: string, extra: string[]): string | null {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  for (const dir of [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), ...extra]) {
    const p = path.join(dir, exe);
    if (isExecutable(p)) return p;
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (process.platform === "win32" || (st.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

function commonBinDirs(): string[] {
  const h = homeDir();
  return [...(h ? [".local/bin", ".bun/bin", ".npm-global/bin", ".volta/bin"].map((d) => path.join(h, d)) : []), "/opt/homebrew/bin", "/usr/local/bin"];
}

/** `<home>/phaethon-instance.json` for a managed home (system homes are never read). */
function launchOf(home: string | null): Instance | null {
  if (!home) return null;
  if (home === path.join(homeDir(), ".codex") || home === homeDir()) return null;
  try {
    const v = JSON.parse(fs.readFileSync(path.join(home, "phaethon-instance.json"), "utf8"));
    if (!isObj(v) || typeof v.id !== "string") return null;
    const cli = CLIS.find((c) => c === v.cli);
    if (!cli) return null;
    return {
      id: v.id,
      cli,
      binary: typeof v.binary === "string" ? v.binary.trim() : "",
      args: Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === "string") : [],
    };
  } catch {
    return null;
  }
}

/** `agent_instances::binary`: the connection's own binary when it names one, else the CLI found as usual. */
function instanceBinary(cli: Cli, home: string | null): { bin: string | null; launchArgs: string[] } {
  const launch = launchOf(home);
  const mine = launch && launch.cli === cli ? launch : null;
  const launchArgs = mine?.args ?? [];
  if (mine && mine.binary) {
    const bin = path.isAbsolute(mine.binary) ? (isExecutable(mine.binary) ? mine.binary : null) : findOnPath(mine.binary, commonBinDirs());
    return { bin, launchArgs };
  }
  return { bin: findBinary(cli), launchArgs };
}

function cliModelOf(space: string, cli: Cli): string | null {
  const m = readSpaceMeta(space).cliModels?.[cli];
  if (typeof m !== "string") return null;
  const t = m.trim();
  return isValidCliModel(t) ? t : null;
}

/** `space_model::get_reasoning`. */
function reasoningOf(space: string, cli: Cli, model: string | null): string | null {
  if (model !== null && !isValidCliModel(model)) throw "Invalid model name.";
  const key = model ?? "$default";
  const all = readSpaceMeta(space).cliReasoning;
  if (all === undefined) return null;
  if (!isObj(all)) throw "Invalid saved reasoning settings.";
  const models = all[cli];
  if (models === undefined) return null;
  if (!isObj(models)) throw "Invalid saved reasoning settings.";
  const effort = models[key];
  if (effort === undefined) return null;
  if (typeof effort !== "string" || !validReasoning(cli, effort)) throw "Invalid saved reasoning level.";
  return effort;
}

/**
 * The model for `space`: the vault's CLI when it uses one; otherwise
 * Phaethon's own provider, falling back to Claude Code (when installed) if no
 * provider is set up. The CLI model and reasoning are captured now, so a
 * settings change doesn't affect a workflow (or its retry) already running.
 */
export function modelForSpace(space: string, signal?: AbortSignal): Model {
  let dir: string;
  try {
    dir = spaceDir(space);
  } catch (e) {
    throw errText(e);
  }
  const settings = readSettings();
  const backendCli = cliOfBackend(settings.backend);
  if (backendCli) requireHome(settings, selectedInstance(settings, backendCli));
  const setupFor = (cli: Cli): CliSetup | null => {
    const configDir = requireHome(settings, selectedInstance(settings, cli));
    const { bin, launchArgs } = instanceBinary(cli, configDir);
    if (!bin) return null;
    const model = cliModelOf(space, cli);
    const setup: CliSetup = { bin, cwd: dir, configDir, model, reasoning: reasoningOf(space, cli, model), launchArgs };
    if (signal) setup.signal = signal;
    return setup;
  };
  const claude = (): CliModel | null => {
    try {
      requireHome(settings, selectedInstance(settings, "claude"));
    } catch {
      return null;
    }
    const s = setupFor("claude");
    return s ? new CliModel(s) : null;
  };
  if (backendCli === "claude") {
    const m = claude();
    if (!m) throw MISSING_CLI_MESSAGE;
    return m;
  }
  if (backendCli) {
    const s = setupFor(backendCli);
    if (!s) throw MISSING[backendCli];
    return new OtherCliModel(backendCli, s);
  }
  const ref = typeof readSpaceMeta(space).model === "string" ? (readSpaceMeta(space).model as string) : undefined;
  return new ApiModel(space, ref, signal, claude);
}

// ---- JSON answers -----------------------------------------------------------------

function parseJson(s: string): { ok: true; v: unknown } | { ok: false } {
  try {
    return { ok: true, v: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/** The first JSON value in a reply: the whole of it, a fenced block, or the first balanced `{…}`/`[…]` that parses. */
export function extractJson(reply: string): unknown | undefined {
  const whole = parseJson(reply.trim());
  if (whole.ok) return whole.v;
  const parts = reply.split("```");
  for (let i = 1; i < parts.length; i += 2) {
    const block = parts[i]!.replace(/^[A-Za-z]+/, "").trim();
    const p = parseJson(block);
    if (p.ok) return p.v;
  }
  for (let start = 0; start < reply.length; start++) {
    const b = reply[start];
    if (b !== "{" && b !== "[") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < reply.length; i++) {
      const c = reply[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          const p = parseJson(reply.slice(start, i + 1));
          if (p.ok) return p.v;
          break;
        }
      }
    }
  }
  return undefined;
}

export function askJson<T>(model: Model, system: string, user: string, validate: Validate<T>): Promise<T> {
  return askJsonSeeing(model, system, user, [], validate);
}

function check<T>(reply: string, validate: Validate<T>): { ok: true; v: T } | { ok: false; problem: string } {
  const v = extractJson(reply);
  if (v === undefined) return { ok: false, problem: "the reply had no JSON in it" };
  try {
    return { ok: true, v: validate(v) };
  } catch (e) {
    return { ok: false, problem: errText(e) };
  }
}

/** Ask for JSON and check it; one retry telling the model what was wrong, then an error (nothing saved). */
export async function askJsonSeeing<T>(model: Model, system: string, user: string, pictures: Picture[], validate: Validate<T>): Promise<T> {
  const ask = async (u: string): Promise<string> => {
    try {
      return pictures.length ? await model.completeSeeing(system, u, pictures) : await model.complete(system, u);
    } catch (e) {
      throw errText(e);
    }
  };
  const reply = await ask(user);
  const first = check(reply, validate);
  if (first.ok) return first.v;
  const shown = [...reply].slice(0, 4000).join("");
  const retry = `${user}\n\n<previous_reply>\n${shown}\n</previous_reply>\n\nThat reply couldn't be used: ${first.problem}. Answer again with only the corrected JSON, in the same format.`;
  const second = check(await ask(retry), validate);
  if (second.ok) return second.v;
  throw `The model’s answer couldn’t be used (${second.problem}), so nothing was saved. Try again.`;
}
