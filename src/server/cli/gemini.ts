// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// (The ACP session sequence of AcpSessionRuntime, the session/update switch of runtimeModel.ts, and the permission policy of clientPolicy.ts, as plain async TypeScript.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, ToolCategory, ToolStatus } from "../../shared/agent.ts";
import { homeDir } from "../env.ts";
import { isWithin, writeFileAtomic } from "../core/fsx.ts";
import type { Outcome } from "./cli.ts";
import { abortion, finishChild, type DriveContext, type Driver, type Invocation } from "./drive.ts";
import { JsonRpcPeer, RpcError } from "./jsonrpc.ts";
import { sleep, stopGroup } from "./process.ts";
import { place, shownPath, ToolEvents, type Granted } from "./tools.ts";

/**
 * Gemini CLI through the Agent Client Protocol (`gemini --acp`), one agent
 * per turn, always with the vault's own GEMINI_CLI_HOME (its global
 * GEMINI.md and settings, hooks included, can't be switched off otherwise).
 * Walled: a policy file denies every tool but reading, listing and
 * searching (passed as admin and user policy), plan approval mode, no
 * extensions, no MCP servers, the workspace trusted only for the run, and a
 * working folder with its own `.gemini` is refused. Permission requests are
 * answered by Phaethon: reads inside the folders it may see, nothing else.
 */

export const ACP_PROTOCOL_VERSION = 1;

const READ_ONLY_POLICY =
  '# Phaethon: Gemini CLI may only read and search the folders it is given.\n[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 900\n\n[[rule]]\ntoolName = ["read_file", "list_directory", "glob", "grep_search", "read_many_files"]\ndecision = "allow"\npriority = 950\n';
const NO_TOOLS_POLICY = '# Phaethon: no tools.\n[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 999\n';
/** An MCP allow-list naming no server, so none connect. */
const NO_MCP = "phaethon-none";

let tmpCounter = 0;

/** The policy file, rewritten atomically in this user's temp folder on every call. */
export function policyFile(noTools: boolean): string {
  const [name, text] = noTools ? ["no-tools", NO_TOOLS_POLICY] : ["read-only", READ_ONLY_POLICY];
  const dir = path.join(os.tmpdir(), "phaethon-gemini");
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `${name}.toml`);
  writeFileAtomic(file, text, { tmp: path.join(dir, `${name}.${process.pid}.${++tmpCounter}.tmp`) });
  return file;
}

/** Options every Gemini CLI call shares (`json` is the output format; sign-in uses "text"). */
export function baseArgs(policy: string, json: string, model: string | null): string[] {
  const args = ["--output-format", json, "--approval-mode", "plan", "--extensions", "none", "--allowed-mcp-server-names", NO_MCP, "--admin-policy", policy, "--policy", policy];
  if (model) args.push("--model", model);
  return args;
}

/** `--include-directories` splits its value on commas, so a path with one would name other folders: left out. */
function includeDirs(dirs: string[]): string[] {
  return dirs.filter((d) => !d.includes(",")).flatMap((d) => ["--include-directories", d]);
}

/** A walled ACP turn. */
export function acpArgs(policy: string, dirs: string[], model: string | null): string[] {
  const args = ["--acp", "--approval-mode", "plan", "--extensions", "none", "--allowed-mcp-server-names", NO_MCP, "--admin-policy", policy, "--policy", policy];
  if (model) args.push("--model", model);
  return [...args, ...includeDirs(dirs)];
}

/** Full access: every tool without asking and the person's home in the workspace; still no extensions or MCP servers. */
export function acpArgsFull(home: string | null, model: string | null): string[] {
  const args = ["--acp", "--approval-mode", "yolo", "--extensions", "none", "--allowed-mcp-server-names", NO_MCP];
  if (model) args.push("--model", model);
  return [...args, ...includeDirs(home ? [home] : [])];
}

/** What Gemini CLI is asked: the mode first (it has no way to add to its system prompt), then the message; a leading `/` is escaped. */
export function geminiPrompt(mode: string | null, message: string): string {
  const text = message.startsWith("/") ? ` ${message}` : message;
  return mode ? `<phaethon_tutor_mode>\n${mode}\n</phaethon_tutor_mode>\n\n${text}` : text;
}

export function hasOwnSettings(dir: string): boolean {
  try {
    fs.lstatSync(path.join(dir, ".gemini"));
    return true;
  } catch {
    return false;
  }
}

export function invocation(ctx: DriveContext): Invocation {
  const env = { GEMINI_CLI_TRUST_WORKSPACE: "true" };
  if (ctx.fullAccess) return { args: acpArgsFull(homeDir() || null, ctx.model), env };
  let policy: string;
  try {
    policy = policyFile(false);
  } catch (e) {
    throw new Error(`Phaethon couldn’t prepare Gemini CLI’s read-only rules: ${(e as Error).message}`);
  }
  return { args: acpArgs(policy, ctx.dirs, ctx.model), env };
}

// ---- Permission policy (after T3's clientPolicy.ts) ----

type ToolCall = { toolCallId?: unknown; title?: unknown; kind?: unknown; status?: unknown; locations?: unknown; rawInput?: unknown };

const READ_KINDS = new Set(["read", "search", "think"]);

function locationsOf(call: ToolCall): string[] {
  return Array.isArray(call.locations) ? call.locations.map((l) => (l as { path?: unknown })?.path).filter((p): p is string => typeof p === "string") : [];
}

/** Canonical form of a path for containment checks: existing ancestors resolved, failing closed. */
function canonical(p: string): string | null {
  let candidate = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.resolve(fs.realpathSync.native(candidate), ...rest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    rest.unshift(path.basename(candidate));
    candidate = parent;
  }
}

/** Allow reads inside the folders the turn may see; deny everything else (allow everything with full access). */
export function permissionDecision(call: ToolCall, roots: string[], fullAccess: boolean): "allow" | "deny" {
  if (fullAccess) return "allow";
  const kind = typeof call.kind === "string" ? call.kind : "other";
  if (!READ_KINDS.has(kind)) return "deny";
  const canonicalRoots = roots.map(canonical).filter((r): r is string => r !== null);
  for (const loc of locationsOf(call)) {
    const resolved = path.isAbsolute(loc) ? loc : roots[0] ? path.join(roots[0], loc) : null;
    const c = resolved ? canonical(resolved) : null;
    if (!c || !canonicalRoots.some((r) => isWithin(c, r))) return "deny";
  }
  return "allow";
}

export function permissionAnswer(params: unknown, roots: string[], fullAccess: boolean): unknown {
  const p = (params ?? {}) as { toolCall?: ToolCall; options?: unknown };
  const options = Array.isArray(p.options) ? (p.options as { optionId?: unknown; kind?: unknown }[]) : [];
  const decision = permissionDecision(p.toolCall ?? {}, roots, fullAccess);
  const wanted = decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const option = options.find((o) => o.kind === kind && typeof o.optionId === "string");
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

// ---- session/update → AgentEvents ----

const KIND_CATEGORY: Record<string, ToolCategory> = { read: "read", search: "search", execute: "command", edit: "write", delete: "write", move: "write", fetch: "search" };

export class GeminiUpdates {
  #tools: ToolEvents;
  #emittedText = false;
  #afterTool = false;

  constructor(
    private readonly base: string,
    private readonly granted: Granted,
  ) {
    this.#tools = new ToolEvents("gemini", base, granted);
  }

  get emittedText(): boolean {
    return this.#emittedText;
  }

  #label(call: ToolCall, category: ToolCategory, file: string | undefined): string {
    const input = (call.rawInput && typeof call.rawInput === "object" ? call.rawInput : {}) as Record<string, unknown>;
    switch (category) {
      case "read":
        return file ? place("Reading", file, this.base, this.granted) : "Reading files";
      case "search":
        if (call.kind === "fetch") return "Fetching a web page";
        if (typeof input.pattern === "string") return `Searching files for “${input.pattern}”`;
        return file ? `Listing ${shownPath(file, this.base, this.granted).shown}` : "Searching files";
      case "command":
        return "Running a command";
      case "write":
        return file ? place("Changing", file, this.base, this.granted) : "Changing files";
      default:
        return typeof call.title === "string" && call.title ? `Using tool ${call.title}` : "Using a tool";
    }
  }

  #end(call: ToolCall): AgentEvent[] {
    const status: ToolStatus | null = call.status === "completed" ? "success" : call.status === "failed" ? "failed" : null;
    if (!status) return [];
    return this.#tools.end(String(call.toolCallId ?? ""), status, status === "failed" ? "Tool reported an error" : undefined);
  }

  update(u: Record<string, unknown>): AgentEvent[] {
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const content = (u.content ?? {}) as { type?: unknown; text?: unknown };
        if (content.type !== "text" || typeof content.text !== "string" || !content.text) return [];
        const out: AgentEvent[] = [];
        if (this.#afterTool && this.#emittedText) out.push({ kind: "text", delta: "\n\n" });
        this.#afterTool = false;
        this.#emittedText = true;
        out.push({ kind: "text", delta: content.text });
        return out;
      }
      case "tool_call": {
        const call = u as ToolCall;
        const category = KIND_CATEGORY[String(call.kind)] ?? "other";
        const input = (call.rawInput && typeof call.rawInput === "object" ? call.rawInput : {}) as Record<string, unknown>;
        const file = locationsOf(call)[0] ?? (["file_path", "absolute_path", "dir_path", "path"].map((k) => input[k]).find((v) => typeof v === "string" && v) as string | undefined);
        this.#afterTool = true;
        const target = file ? { path: file } : input;
        return [...this.#tools.start(String(call.toolCallId ?? ""), category, target, this.#label(call, category, file)), ...this.#end(call)];
      }
      case "tool_call_update":
        return this.#end(u as ToolCall);
      default:
        return [];
    }
  }
}

function isAuthError(e: unknown): boolean {
  return e instanceof RpcError && (e.code === -32000 || /auth/i.test(e.message));
}

function rpcText(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const data = e instanceof RpcError && e.data !== undefined ? (typeof e.data === "string" ? e.data : JSON.stringify(e.data)) : "";
  return data && !e.message.includes(data) ? `${e.message}: ${data}` : e.message;
}

export const drive: Driver = async (gc, ctx, emit) => {
  const updates = new GeminiUpdates(ctx.workingDir, ctx.granted);
  const signal = ctx.run.abort.signal;
  const aborted = abortion(signal);
  const roots = [ctx.workingDir, ...ctx.dirs];
  let sessionId: string | null = null;
  // While a session loads, the agent replays its history as updates: not this turn's.
  let live = false;

  const peer = new JsonRpcPeer(gc.stdin!, gc.stdout, {
    jsonrpc: true,
    onRequest: (method, params) => {
      if (method === "session/request_permission") return permissionAnswer(params, roots, ctx.fullAccess);
      throw new RpcError(-32601, `Method not found: ${method}`);
    },
    onNotification: (method, params) => {
      if (method !== "session/update" || !live) return;
      const p = (params ?? {}) as { sessionId?: unknown; update?: unknown };
      if (sessionId && p.sessionId !== sessionId) return;
      updates.update((p.update ?? {}) as Record<string, unknown>).forEach(emit);
    },
  });

  let prompting: Promise<unknown> | null = null;
  const stop = async (): Promise<"stopped"> => {
    if (sessionId && prompting && !peer.closed) {
      peer.notify("session/cancel", { sessionId });
      await Promise.race([prompting.catch(() => {}), sleep(1000)]);
    }
    peer.close();
    await stopGroup(gc, ctx.run);
    return "stopped";
  };
  const ended = peer.ended.then(() => "ended" as const);
  const step = async <T>(p: Promise<T>): Promise<T | "abort" | "ended"> => Promise.race([p, aborted, ended]);
  const incomplete = (): Outcome => ({ kind: "incomplete", message: "" });

  try {
    let init: unknown;
    try {
      init = await step(
        peer.request("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "phaethon", version: process.env.PHAETHON_VERSION ?? "0.2.0" },
        }),
      );
    } catch (e) {
      return { kind: "failed", message: rpcText(e) };
    }
    if (init === "abort") return await stop();
    if (init === "ended") return incomplete();
    const canLoad = (init as { agentCapabilities?: { loadSession?: unknown } } | undefined)?.agentCapabilities?.loadSession === true;

    if (ctx.resume) {
      // An agent that can't load sessions can't resume this one: start afresh with the conversation as text.
      if (!canLoad) return { kind: "failed", message: "Error resuming session: this Gemini CLI can’t load earlier sessions.", stale: true };
      try {
        const loaded = await step(peer.request("session/load", { sessionId: ctx.resume, cwd: ctx.workingDir, mcpServers: [] }));
        if (loaded === "abort") return await stop();
        if (loaded === "ended") return incomplete();
      } catch (e) {
        if (isAuthError(e)) return { kind: "failed", message: rpcText(e), notLoggedIn: true };
        return { kind: "failed", message: `Error resuming session: ${rpcText(e)}`, stale: true };
      }
      sessionId = ctx.resume;
    } else {
      let created: unknown;
      try {
        created = await step(peer.request("session/new", { cwd: ctx.workingDir, mcpServers: [] }));
      } catch (e) {
        return { kind: "failed", message: rpcText(e), notLoggedIn: isAuthError(e) };
      }
      if (created === "abort") return await stop();
      if (created === "ended") return incomplete();
      sessionId = String((created as { sessionId?: unknown } | undefined)?.sessionId ?? "") || null;
    }
    live = true;

    prompting = peer.request("session/prompt", { sessionId, prompt: [{ type: "text", text: geminiPrompt(ctx.mode, ctx.prompt) }] });
    let result: unknown;
    try {
      result = await step(prompting);
    } catch (e) {
      return { kind: "failed", message: rpcText(e), notLoggedIn: isAuthError(e) };
    }
    if (result === "abort" || signal.aborted) return await stop();
    if (result === "ended") return incomplete();
    const stopReason = (result as { stopReason?: unknown } | undefined)?.stopReason;
    peer.close();
    await finishChild(gc, ctx.run);
    if (stopReason === "refusal") return { kind: "failed", message: "Gemini CLI stopped: refusal." };
    if (stopReason === "cancelled") return { kind: "failed", message: "Gemini CLI stopped." };
    return { kind: "success", sessionId };
  } finally {
    peer.close();
  }
};
