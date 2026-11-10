// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// (The app-server method sequence, approval answers and item mapping of CodexAdapterV2 / CodexProvider, as plain async TypeScript.)
import fs from "node:fs";
import path from "node:path";
import type { AgentEvent, ToolStatus } from "../../shared/agent.ts";
import type { Outcome } from "./cli.ts";
import { abortion, finishChild, type DriveContext, type Driver, type Invocation } from "./drive.ts";
import { JsonRpcPeer, RpcError } from "./jsonrpc.ts";
import { sleep, stopGroup } from "./process.ts";
import { shownPath, ToolEvents, type Granted } from "./tools.ts";

/**
 * Codex through `codex app-server` (JSON-RPC over stdio), one server per
 * turn, always with the vault's own CODEX_HOME. Walled, a permissions
 * profile `phaethon` grants read access only to the working folder, granted
 * folders and Codex's own install, with no network and approvals never
 * asked; any approval request that still arrives is declined. Thread ids
 * are the conversation's session (`codex:<uuid>`).
 */

/** The features Codex has that a walled space must not get (and full access doesn't need from the person's setup). */
export const DISABLED_FEATURES = [
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

export const CLIENT_INFO = { name: "phaethon", version: "0.1.2" };

/** `[dirname(bin)]`, plus the install a symlinked binary points into (Homebrew, npm). */
export function ownDirs(bin: string): string[] {
  const dirs = [path.dirname(bin)];
  try {
    const real = fs.realpathSync.native(bin);
    if (real !== bin) dirs.push(path.dirname(path.dirname(real)));
  } catch {
    // not resolvable: only its folder
  }
  return dirs;
}

/** A TOML basic string: JSON escaping keeps quotes and backslashes inside it. */
const toml = (s: string) => JSON.stringify(s);

function shared(): string[] {
  return [
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "skills.include_instructions=false",
    "-c",
    "skills.bundled.enabled=false",
    // The app-server has no --ignore-user-config: no MCP server from any config.toml.
    "-c",
    "mcp_servers={}",
    ...DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
  ];
}

/** `app-server` arguments for a walled turn: read-only profile over `readable`, no network, no approvals asked. */
export function appServerArgs(readable: string[]): string[] {
  const filesystem = `{${[`":minimal"="read"`, ...readable.map((p) => `${toml(p)}="read"`)].join(",")}}`;
  return [
    "app-server",
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "-c",
    'default_permissions="phaethon"',
    "-c",
    `permissions.phaethon.filesystem=${filesystem}`,
    ...shared(),
  ];
}

export function appServerArgsFull(): string[] {
  return ["app-server", ...shared()];
}

export function invocation(ctx: DriveContext): Invocation {
  if (ctx.fullAccess) return { args: appServerArgsFull() };
  return { args: appServerArgs([ctx.workingDir, ...ctx.dirs, ...ownDirs(ctx.bin)]) };
}

/** "Running cat notes.md": the command without the shell Codex wraps it in, paths shown as in the space. */
export function commandLabel(command: string, base: string, granted: Granted): string {
  let inner = command;
  for (const sep of [" -lc ", " -c "]) {
    const at = command.indexOf(sep);
    if (at >= 0) {
      inner = command
        .slice(at + sep.length)
        .trim()
        .replace(/^['"]+|['"]+$/g, "");
      break;
    }
  }
  const shown = inner
    .split(" ")
    .map((w) => (w.startsWith("/") ? shownPath(w, base, granted).shown : w))
    .join(" ");
  return `Running ${[...shown].slice(0, 120).join("")}`;
}

type Item = Record<string, unknown> & { type?: unknown; id?: unknown };

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** App-server thread items → Phaethon's tool and text events. */
export class CodexItems {
  #tools: ToolEvents;
  #emittedText = false;
  #textItem: string | null = null;
  #deltaItems = new Set<string>();

  constructor(
    private readonly base: string,
    private readonly granted: Granted,
  ) {
    this.#tools = new ToolEvents("codex", base, granted);
  }

  get emittedText(): boolean {
    return this.#emittedText;
  }

  #text(itemId: string, delta: string): AgentEvent[] {
    if (!delta) return [];
    const out: AgentEvent[] = [];
    if (itemId !== this.#textItem) {
      if (this.#emittedText) out.push({ kind: "text", delta: "\n\n" });
      this.#textItem = itemId;
    }
    this.#emittedText = true;
    out.push({ kind: "text", delta });
    return out;
  }

  delta(itemId: string, delta: string): AgentEvent[] {
    this.#deltaItems.add(itemId);
    return this.#text(itemId, delta);
  }

  #start(item: Item): AgentEvent[] {
    const id = str(item.id);
    switch (item.type) {
      case "commandExecution":
        return this.#tools.start(id, "command", item, commandLabel(str(item.command), this.base, this.granted));
      case "webSearch":
        return this.#tools.start(id, "search", item, `Searching the web for “${str(item.query)}”`);
      case "mcpToolCall":
        return this.#tools.start(id, "other", item, `Using tool ${str(item.tool)}`);
      case "dynamicToolCall":
        return this.#tools.start(id, "other", item, `Using tool ${str(item.tool)}`);
      case "fileChange":
        return this.#tools.start(id, "write", item, "Changing files");
      default:
        return [];
    }
  }

  started(item: Item): AgentEvent[] {
    return this.#start(item);
  }

  completed(item: Item): AgentEvent[] {
    if (item.type === "agentMessage") {
      const id = str(item.id);
      return this.#deltaItems.has(id) ? [] : this.#text(id, str(item.text));
    }
    // A fast tool may only report that it completed.
    const out = this.#start(item);
    if (!out.length && !["commandExecution", "webSearch", "mcpToolCall", "dynamicToolCall", "fileChange"].includes(String(item.type))) return out;
    const exit = item.exitCode;
    const failed =
      item.status === "failed" ||
      item.status === "declined" ||
      (item.error !== undefined && item.error !== null) ||
      (typeof exit === "number" && Number.isInteger(exit) && exit !== 0) ||
      item.success === false;
    let status: ToolStatus = "success";
    if (failed) status = "failed";
    else if (item.type === "commandExecution" && (exit === null || exit === undefined)) status = "incomplete";
    const detail = typeof exit === "number" && Number.isInteger(exit) ? `Exit code ${exit}` : failed ? "Tool reported an error" : undefined;
    return [...out, ...this.#tools.end(str(item.id), status, detail)];
  }
}

/** Every request the app-server makes of the client, answered so nothing is approved in a walled turn. */
export function answerServerRequest(method: string, fullAccess: boolean): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: fullAccess ? "accept" : "decline" };
    case "execCommandApproval":
    case "applyPatchApproval":
      return { decision: fullAccess ? "approved" : { denied: { rejection: "Phaethon keeps this assistant read-only here." } } };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/tool/call":
      return { contentItems: [], success: false };
    default:
      // Token refreshes and attestation included: Phaethon never handles credentials.
      throw new RpcError(-32601, `Phaethon does not handle ${method}.`);
  }
}

function errorText(error: unknown): string {
  const e = (error ?? {}) as { message?: unknown; additionalDetails?: unknown };
  return [str(e.message), str(e.additionalDetails)].filter(Boolean).join(" ");
}

export const drive: Driver = async (gc, ctx, emit) => {
  const items = new CodexItems(ctx.workingDir, ctx.granted);
  const signal = ctx.run.abort.signal;
  const aborted = abortion(signal);
  let threadId: string | null = null;
  let turnId: string | null = null;
  let lastError = "";
  let completed: ((outcome: Outcome) => void) | undefined;
  const turnDone = new Promise<Outcome>((r) => (completed = r));

  const peer = new JsonRpcPeer(gc.stdin!, gc.stdout, {
    onRequest: (method) => answerServerRequest(method, ctx.fullAccess),
    onNotification: (method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      if (threadId && typeof p.threadId === "string" && p.threadId !== threadId) return;
      switch (method) {
        case "item/agentMessage/delta":
          items.delta(str(p.itemId), str(p.delta)).forEach(emit);
          break;
        case "item/started":
          items.started((p.item ?? {}) as Item).forEach(emit);
          break;
        case "item/completed":
          items.completed((p.item ?? {}) as Item).forEach(emit);
          break;
        case "error":
          // Shown only if the turn fails (e.g. "Reconnecting... 2/5").
          lastError = errorText(p.error) || lastError;
          break;
        case "turn/completed": {
          const turn = (p.turn ?? {}) as { id?: unknown; status?: unknown; error?: unknown };
          if (turnId && turn.id !== turnId) break;
          if (turn.status === "completed") completed?.({ kind: "success", sessionId: threadId });
          else if (turn.status === "interrupted") completed?.({ kind: "failed", message: "Codex stopped." });
          else completed?.({ kind: "failed", message: errorText(turn.error) || lastError || "Codex stopped." });
          break;
        }
      }
    },
  });

  const stop = async (): Promise<"stopped"> => {
    // Let Codex end the turn cleanly (its thread stays resumable), then end the group.
    if (threadId && turnId && !peer.closed) {
      peer.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      await Promise.race([turnDone, sleep(1000)]);
    }
    peer.close();
    await stopGroup(gc, ctx.run);
    return "stopped";
  };

  const ended = peer.ended.then(() => "ended" as const);
  const step = async <T>(p: Promise<T>): Promise<T | "abort" | "ended"> => Promise.race([p, aborted, ended]);
  const failed = (e: unknown, extra: Partial<Extract<Outcome, { kind: "failed" }>> = {}): Outcome => ({
    kind: "failed",
    message: e instanceof Error ? e.message : String(e),
    ...extra,
  });

  try {
    const init = await step(peer.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } }));
    if (init === "abort") return await stop();
    if (init === "ended") return { kind: "incomplete", message: lastError };
    peer.notify("initialized", {});

    // Signed out: say so now instead of letting Codex retry a 401 for a while.
    const acct = await step(peer.request<{ account?: unknown; requiresOpenaiAuth?: unknown }>("account/read", { refreshToken: false }).catch(() => null));
    if (acct === "abort") return await stop();
    if (acct === "ended") return { kind: "incomplete", message: lastError };
    if (acct && acct.requiresOpenaiAuth === true && !acct.account) return { kind: "failed", message: "Not logged in", notLoggedIn: true };

    const threadParams: Record<string, unknown> = {
      cwd: ctx.workingDir,
      approvalPolicy: "never",
      developerInstructions: ctx.mode,
    };
    if (ctx.fullAccess) threadParams.sandbox = "danger-full-access";
    if (ctx.model) threadParams.model = ctx.model;
    let thread: unknown;
    try {
      thread = ctx.resume
        ? await step(peer.request("thread/resume", { ...threadParams, threadId: ctx.resume }))
        : await step(peer.request("thread/start", { ...threadParams, ephemeral: false }));
    } catch (e) {
      // A thread Codex can't find ("no rollout found…") starts afresh with the conversation as text.
      const gone = ctx.resume !== null && e instanceof RpcError && /no rollout found|not found/i.test(e.message);
      return failed(e, gone ? { stale: true } : {});
    }
    if (thread === "abort") return await stop();
    if (thread === "ended") return { kind: "incomplete", message: lastError };
    threadId = str((thread as { thread?: { id?: unknown } } | undefined)?.thread?.id) || null;

    const turnParams: Record<string, unknown> = { threadId, input: [{ type: "text", text: ctx.prompt, text_elements: [] }] };
    if (ctx.reasoning) turnParams.effort = ctx.reasoning;
    let turn: unknown;
    try {
      turn = await step(peer.request("turn/start", turnParams));
    } catch (e) {
      return failed(e);
    }
    if (turn === "abort") return await stop();
    if (turn === "ended") return { kind: "incomplete", message: lastError };
    turnId = str((turn as { turn?: { id?: unknown } } | undefined)?.turn?.id) || null;

    const outcome = await Promise.race([turnDone, aborted, ended]);
    if (outcome === "abort") return await stop();
    if (outcome === "ended") return { kind: "incomplete", message: lastError };
    if (signal.aborted) return await stop();
    peer.close();
    await finishChild(gc, ctx.run);
    return outcome;
  } finally {
    peer.close();
  }
};
