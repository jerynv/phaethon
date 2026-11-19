import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log as coreLog } from "../log.ts";
import type { AgentEvent, ErrorCode, UiRecord } from "../../shared/agent.ts";
import type { Channel } from "../rpc/channel.ts";
import { claim, release, turnKey, type Run } from "../core/runs.ts";
import { load, recordBlock, save, stamped, userMessage, type Block, type Message, type Record_ } from "../core/thread.ts";
import { toolHost, type ToolHost } from "./phaethon-tools.ts";
import { openTurnTools } from "./mcp-http.ts";
import { realpath } from "../core/fsx.ts";
import { cutAt } from "../threads/store.ts";
import { BUSY_MESSAGE, CLI, cliName, INELIGIBLE_MESSAGE, isGeminiIneligible, isValidCliModel, lastLine, notLoggedInMessage, OWN_SETTINGS_MESSAGE, REASONING_UNSUPPORTED, stderrSummary, validReasoning, type CliId, type Outcome } from "./cli.ts";
import * as claude from "./claude.ts";
import * as codex from "./codex.ts";
import { finishChild, type DriveContext, type Driver, type Invocation } from "./drive.ts";
import * as gemini from "./gemini.ts";
import { binary, cliCommand, sessionTag } from "./instances.ts";
import { isExecutable, spawnInGroup, stopGroup, type GroupChild } from "./process.ts";
import { attachmentNote, cliPrompt, cliTurn, systemText } from "./prompt.ts";
import { getReasoning } from "./reasoning.ts";
import { clearSession, readCliSession, writeCliSession } from "./session.ts";
import { ToolLog, type Granted } from "./tools.ts";
import { wallBreakingArg, wallBreakingMessage } from "./walls.ts";

/** One turn of a CLI backend, as the agent worker's `agent_send` hands it over. */
export type CliTurnRequest = {
  cli: CliId;
  space: string;
  /** The conversation the turn is recorded in, and whose CLI session it resumes. */
  thread: string;
  spaceDir: string;
  /** Device-local, picker-approved project root; null runs the CLI in the space folder. */
  workingDir: string | null;
  /** What the user wrote, saved as written. */
  prompt: string;
  /** Saved attachment reference blocks. */
  attachments: Block[];
  /** Edit or regenerate: the thread index of the user message this one replaces. */
  replaceFrom?: number;
  /** The selected instance's home; null lets Claude Code use the person's own config. */
  configDir: string | null;
  /** Other spaces' "always" grants and fully visible courses the CLI may read. */
  addDirs: { label: string; path: string }[];
  /** The space's model for this CLI (`space.json` `cliModels.<cli>`). */
  model: string | null;
  /** The space's reasoning level; read from `space.json` when undefined. */
  reasoning?: string | null;
  fullAccess: boolean;
};

const BACKENDS: Record<CliId, { invocation: (ctx: DriveContext) => Invocation; drive: Driver }> = {
  claude: { invocation: claude.invocation, drive: claude.drive },
  codex: { invocation: codex.invocation, drive: codex.drive },
  gemini: { invocation: gemini.invocation, drive: gemini.drive },
};

type Attempt = { kind: "notStarted" } | { kind: "done"; sessionId: string | null } | { kind: "failed" } | { kind: "stopped" } | { kind: "stale" };

const error = (code: ErrorCode, message: string): AgentEvent => ({ kind: "error", code, message });

/** Classifies non-auth CLI failures into connectivity, rate-limit, availability, or generic CLI codes. */
export function classifyCliError(detail: string, stderr = ""): ErrorCode {
  const text = `${detail}\n${stderr}`;
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|\bnetwork\b|timed out while connecting|socket hang up|unable to connect/i.test(text)) {
    return "network";
  }
  if (/\b429\b|RESOURCE_EXHAUSTED|rate[ _-]?limit|quota exceeded|too many requests/i.test(text)) {
    return "rateLimit";
  }
  if (/\b(?:502|503|504)\b|\bUNAVAILABLE\b|overloaded|service unavailable/i.test(text)) {
    return "unavailable";
  }
  return "cli";
}

/** The folder the CLI runs in, checked: a real folder, not a link, and (for a bound project) where it was approved. */
function workingDirectory(req: CliTurnRequest): string {
  const dir = req.workingDir ?? req.spaceDir;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    throw new Error(`The workspace folder is unavailable. Choose it again: ${(e as Error).message}`);
  }
  let real: string | null = null;
  try {
    real = realpath(dir);
  } catch {
    real = null;
  }
  if (!st.isDirectory() || st.isSymbolicLink() || (req.workingDir !== null && real !== dir)) {
    throw new Error("The workspace folder changed or is unavailable. Choose it again.");
  }
  return dir;
}

/**
 * Runs one turn, claiming the conversation itself: a busy one gets the busy error.
 * Always ends with exactly one `end`.
 */
export async function runCliTurnClaimed(req: CliTurnRequest, events: Channel<AgentEvent>): Promise<void> {
  const run = claim(turnKey(req.space, req.thread));
  if (!run) {
    events.send(error("busy", BUSY_MESSAGE));
    events.send({ kind: "end", sessionId: null });
    return;
  }
  try {
    await runCliTurn(req, events, run);
  } finally {
    release(run);
  }
}

/**
 * Runs the body of a CLI turn without releasing `run` or sending `end`.
 * Callers that manage turn lifecycle (such as automatic fallback in `agentSend`)
 * use this so `run` stays claimed across fallback attempts.
 */
export async function runCliTurnBody(req: CliTurnRequest, events: Channel<AgentEvent>, run: Run): Promise<string | null> {
  try {
    return await turn(req, (e) => events.send(e), run);
  } catch (e) {
    events.send(error("cli", e instanceof Error ? e.message : String(e)));
    return null;
  }
}

/**
 * One turn of a CLI in a conversation the caller has claimed (`run`): run the
 * CLI (once more, afresh, if the session it was to resume is gone), record the
 * turn in the conversation the way Phaethon's own loop does, release the run, and
 * end the channel with exactly one `end` carrying the session the
 * conversation resumes next.
 */
export async function runCliTurn(req: CliTurnRequest, events: Channel<AgentEvent>, run: Run): Promise<void> {
  let session: string | null = null;
  try {
    session = await runCliTurnBody(req, events, run);
  } finally {
    // Released before `end`, so the next message never finds the conversation busy.
    release(run);
    events.send({ kind: "end", sessionId: session });
  }
}

async function turn(req: CliTurnRequest, emit: (e: AgentEvent) => void, run: Run): Promise<string | null> {
  const { cli } = req;
  let workingDir: string;
  try {
    workingDir = workingDirectory(req);
  } catch (e) {
    emit(error("cli", (e as Error).message));
    return null;
  }
  if (cli === "gemini" && gemini.hasOwnSettings(workingDir)) {
    emit(error("cli", OWN_SETTINGS_MESSAGE));
    return null;
  }
  const model = isValidCliModel(req.model) ? req.model : null;
  // Captured once: a stale-session retry keeps this turn's reasoning.
  let reasoning: string | null;
  try {
    reasoning = req.reasoning === undefined ? getReasoning(req.spaceDir, cli, model) : req.reasoning;
  } catch (e) {
    emit(error("storage", (e as Error).message));
    return null;
  }

  let msgs: Message[];
  try {
    msgs = load(req.space, req.thread);
  } catch (e) {
    emit(error("storage", `This conversation’s file couldn’t be read, so nothing was sent: ${(e as Error).message}`));
    return null;
  }
  if (req.replaceFrom !== undefined) {
    try {
      const kept = cutAt(req.space, req.thread, msgs, req.replaceFrom) as Message[] | void;
      if (Array.isArray(kept)) msgs = kept;
    } catch (e) {
      emit(error("storage", (e as Error).message));
      return null;
    }
    try {
      save(req.space, req.thread, msgs);
    } catch (e) {
      emit(error("storage", `The conversation could not be saved, so nothing was sent: ${(e as Error).message}`));
      return null;
    }
  }

  const user = stamped(userMessage(req.prompt, req.attachments));
  const external = workingDir !== req.spaceDir;
  const ask = req.prompt + attachmentNote(req.attachments, req.spaceDir, external);
  const tag = sessionTag(cli, req.configDir);
  let resume = readCliSession(req.spaceDir, req.thread, tag);
  const mode = systemText({ space: req.space, spaceDir: req.spaceDir, workingDir, fullAccess: req.fullAccess, turn: cliTurn(req.prompt, msgs) });
  const dirs = req.addDirs.map((d) => d.path);
  if (external && !req.fullAccess && !dirs.includes(req.spaceDir)) dirs.push(req.spaceDir);
  const granted: Granted = [...req.addDirs];
  if (external) granted.push({ label: `Space ${req.space}`, path: req.spaceDir });

  const state = { text: "" };
  const log = new ToolLog();
  const send = (e: AgentEvent) => {
    if (e.kind === "text") state.text += e.delta;
    log.emit(e, emit);
  };

  let stopped = false;
  let failed = false;
  let session: string | null = null;
  // What Phaethon's tools did in this turn (a memory saved, a person added, an email card), shown now and saved with the reply.
  const lifeRecords: Record_[] = [];
  const tools = toolHost({
    space: req.space,
    thread: req.thread,
    signal: run.abort.signal,
    onRecord: (r) => {
      lifeRecords.push(r);
      emit({ kind: "record", record: r as UiRecord });
    },
  });
  // Claude Code and Gemini CLI reach the same tools over local MCP, open for this turn only.
  const mcp = cli === "codex" ? undefined : await openMcpForTurn(tools).catch((e) => (coreLog.warn("Phaethon's tools couldn't be offered over MCP", { error: String(e) }), undefined));
  try {
  for (;;) {
    const ctx = { space: req.space, spaceDir: req.spaceDir, workingDir, prompt: cliPrompt(ask, msgs, resume === null), mode, resume, model, reasoning, dirs, granted, fullAccess: req.fullAccess, run, tools, ...(mcp ? { mcp: mcp.info } : {}) };
    const attempt = await drive(req, ctx, emit, send, state);
    if (attempt.kind === "stale") {
      // The session is gone (deleted, or made elsewhere): start afresh, with the conversation so far.
      clearSession(req.spaceDir, req.thread);
      resume = null;
      continue;
    }
    if (attempt.kind === "notStarted") return null;
    if (attempt.kind === "done") session = attempt.sessionId;
    else if (attempt.kind === "stopped") {
      stopped = true;
      // The CLI may not have saved the turn; the conversation keeps resuming its previous session.
      session = resume;
    } else failed = true;
    break;
  }
  } finally {
    mcp?.close();
  }

  log.close(stopped ? "cancelled" : failed ? "failed" : "incomplete", emit);
  msgs.push(user);
  const content: Block[] = [];
  const text = state.text.trimEnd();
  if (text.trim()) content.push({ type: "text", text });
  if (stopped) content.push(recordBlock({ kind: "stopped" }));
  content.push(...log.records.map((r) => recordBlock(r)), ...lifeRecords.map((r) => recordBlock(r)));
  if (content.length) msgs.push(stamped({ role: "assistant", content }));
  try {
    save(req.space, req.thread, msgs);
  } catch (e) {
    emit(error("storage", `The reply couldn’t be saved in this conversation: ${(e as Error).message}`));
  }
  if (stopped) {
    emit({ kind: "record", record: { kind: "stopped" } });
    emit({ kind: "cancelled" });
  }
  return session;
}

/** Opens the turn's MCP endpoint and writes Claude Code's config for it to a private file (never argv). */
async function openMcpForTurn(tools: ToolHost): Promise<{ info: { url: string; token: string; configFile: string }; close: () => void }> {
  const t = await openTurnTools(tools);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-mcp-"));
  const configFile = path.join(dir, "mcp.json");
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { phaethon: { type: "http", url: t.url, headers: { Authorization: `Bearer ${t.token}` } } } }), { mode: 0o600 });
  return {
    info: { url: t.url, token: t.token, configFile },
    close: () => {
      t.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One run of the CLI. Errors are emitted here. */
async function drive(
  req: CliTurnRequest,
  partial: Omit<DriveContext, "cli" | "cmd" | "bin">,
  emit: (e: AgentEvent) => void,
  send: (e: AgentEvent) => void,
  state: { text: string },
): Promise<Attempt> {
  const { cli, configDir } = req;
  const name = cliName(cli);
  if (CLI[cli].ownHome && configDir === null) {
    emit(error("cli", `Phaethon couldn’t find a folder for ${name}’s own setup in this Phaethon folder, so nothing was sent.`));
    return { kind: "notStarted" };
  }
  const bin = binary(cli, configDir);
  if (!bin) {
    emit(error("missingCli", CLI[cli].missing));
    return { kind: "notStarted" };
  }
  const cmd = cliCommand(cli, bin, partial.workingDir, configDir);
  const ctx: DriveContext = { ...partial, cli, cmd, bin };
  let inv: Invocation;
  try {
    if (partial.reasoning !== null && (cli === "gemini" || !validReasoning(cli, partial.reasoning))) throw new Error(REASONING_UNSUPPORTED);
    if (!req.fullAccess) {
      const breaking = wallBreakingArg(cli, cmd.args);
      if (breaking !== null) throw new Error(wallBreakingMessage(cli, breaking));
    }
    inv = BACKENDS[cli].invocation(ctx);
    workingDirectory(req);
  } catch (e) {
    emit(error("cli", (e as Error).message));
    return { kind: "notStarted" };
  }

  let gc: GroupChild;
  try {
    // A binary that isn't there (or isn't executable) is reported before the group shell starts.
    if (!fs.existsSync(cmd.file)) throw Object.assign(new Error(`spawn ${cmd.file} ENOENT`), { code: "ENOENT" });
    if (!isExecutable(cmd.file)) throw Object.assign(new Error(`spawn ${cmd.file} EACCES`), { code: "EACCES" });
    gc = await spawnInGroup(cmd.file, [...cmd.args, ...inv.args], { cwd: partial.workingDir, env: { ...cmd.env, ...inv.env }, run: partial.run, input: inv.input });
  } catch (e) {
    try {
      workingDirectory(req);
    } catch {
      emit(error("cli", `The workspace folder is unavailable. Choose it again: ${(e as Error).message}`));
      return { kind: "notStarted" };
    }
    if ((e as NodeJS.ErrnoException).code === "ENOENT") emit(error("missingCli", CLI[cli].missing));
    else emit(error("cli", `Could not start ${name} in its workspace: ${(e as Error).message}`));
    return { kind: "notStarted" };
  }

  let outcome: "stopped" | Outcome;
  try {
    outcome = await BACKENDS[cli].drive(gc, ctx, send);
  } catch (e) {
    outcome = { kind: "incomplete", message: e instanceof Error ? e.message : String(e) };
  }
  if (outcome === "stopped" || partial.run.abort.signal.aborted) {
    if (!gc.hasExited()) await stopGroup(gc, partial.run);
    gc.dispose();
    return { kind: "stopped" };
  }
  // The CLI said its last; make sure nothing of its group is left behind (a
  // protocol server that ended the turn early gets its stdin closed first).
  if (!gc.hasExited()) await finishChild(gc, partial.run);
  const exit = await gc.exited;
  const stderr = await gc.stderrText(1000);
  gc.dispose();

  if (outcome.kind === "success") {
    if (outcome.sessionId) {
      try {
        writeCliSession(req.spaceDir, req.thread, sessionTag(cli, configDir), outcome.sessionId);
      } catch (e) {
        emit(error("cli", `Reply received, but the conversation could not be saved: ${(e as Error).message}`));
      }
    }
    return { kind: "done", sessionId: outcome.sessionId };
  }
  const meta = CLI[cli];
  if (cli === "gemini" && ((outcome.kind === "failed" && outcome.ineligible) || isGeminiIneligible(outcome.message) || isGeminiIneligible(stderr))) {
    emit(error("cli", INELIGIBLE_MESSAGE));
    return { kind: "failed" };
  }
  const loggedOut = () => emit(error("notLoggedIn", notLoggedInMessage(cli, configDir)));
  if (outcome.kind === "failed" && (outcome.notLoggedIn || meta.notLoggedIn(outcome.message) || meta.notLoggedIn(stderr))) {
    loggedOut();
    return { kind: "failed" };
  }
  const said = cli === "claude" ? lastLine(stderr) : stderrSummary(stderr);
  const detail =
    [outcome.message.trim(), said].find((s) => s !== "") ??
    (exit.code !== null ? `${name} exited with status ${exit.code}.` : `${name} stopped unexpectedly.`);
  const stale = outcome.kind === "failed" && outcome.stale === true;
  if (partial.resume !== null && (stale || meta.isStale(detail) || meta.isStale(stderr))) {
    if (!state.text) return { kind: "stale" };
    // Gone after it had begun answering (unlikely): start afresh next time.
    clearSession(req.spaceDir, req.thread);
    emit(error("cli", `${name} lost this conversation’s earlier session. Send your message again to carry on in a new one.`));
  } else if (cli === "gemini" && (isGeminiIneligible(detail) || isGeminiIneligible(stderr))) {
    emit(error("cli", INELIGIBLE_MESSAGE));
  } else if (meta.notLoggedIn(detail) || meta.notLoggedIn(stderr)) {
    loggedOut();
  } else {
    emit(error(classifyCliError(detail, stderr), detail));
  }
  return { kind: "failed" };
}
