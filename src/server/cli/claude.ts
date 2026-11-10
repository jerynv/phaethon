// Message normalization ideas adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
import type { AgentEvent } from "../../shared/agent.ts";
import type { Outcome } from "./cli.ts";
import { abortion, type DriveContext, type Driver, type Invocation } from "./drive.ts";
import { readLines, sleep, stopGroup } from "./process.ts";
import { categoryOf, place, ToolEvents, type Granted } from "./tools.ts";

/**
 * Claude Code: the official `claude` the person signed in to, run once per
 * turn with `-p --output-format stream-json`. Walled, it has only the read
 * tools, every other permission is denied without asking, its file tools are
 * confined to the working folder plus granted folders, and none of the
 * person's own setup loads (MCP servers, CLAUDE.md, plugins, hooks, agents,
 * slash commands). `--bare` is never passed: it refuses OAuth, which would
 * break the person's own login.
 */

export const ALLOWED_TOOLS = "Read,Grep,Glob";

const STREAM = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];

export function cliArgs(resume: string | null, addDirs: string[]): string[] {
  const args = [
    ...STREAM,
    // Only these tools exist for the model at all…
    "--tools",
    ALLOWED_TOOLS,
    // …they run without asking…
    "--allowedTools",
    ALLOWED_TOOLS,
    // …and anything else that would need permission is denied, not prompted.
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    // File tools confined to the working directory; user, project and local settings (hooks included) ignored.
    "--restricted",
    "--strict-mcp-config",
    "--no-chrome",
    // No CLAUDE.md auto-discovery, plugins, hooks or custom agents; login still works.
    "--safe-mode",
    "--disable-slash-commands",
  ];
  // `--add-dir` is variadic, so each value is followed by another flag or the end of argv.
  for (const dir of addDirs) args.push("--add-dir", dir);
  if (resume) args.push("--resume", resume);
  return args;
}

/** Full access: every tool, no permission checks; still none of the person's own setup. */
export function cliArgsFull(resume: string | null): string[] {
  const args = [...STREAM, "--dangerously-skip-permissions", "--strict-mcp-config", "--no-chrome", "--safe-mode", "--disable-slash-commands"];
  if (resume) args.push("--resume", resume);
  return args;
}

export function invocation(ctx: DriveContext): Invocation {
  const args = ctx.fullAccess ? cliArgsFull(ctx.resume) : cliArgs(ctx.resume, ctx.dirs);
  if (ctx.model) args.push("--model", ctx.model);
  args.push("--append-system-prompt", ctx.mode);
  if (ctx.reasoning) args.push("--effort", ctx.reasoning);
  return { args, input: ctx.prompt };
}

function toolLabel(block: Record<string, unknown>, base: string, granted: Granted): string {
  const input = (block.input && typeof block.input === "object" ? block.input : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const name = typeof block.name === "string" ? block.name : "";
  switch (name) {
    case "Read":
      return place("Reading", s("file_path"), base, granted);
    case "Grep":
      return `Searching files for “${s("pattern")}”`;
    case "Glob":
      return `Finding files matching ${s("pattern")}`;
    case "":
      return "Using a tool";
    default:
      return `Using tool ${name}`;
  }
}

/** Turns stream-json lines into AgentEvents. Unknown lines are ignored, so new event types don't break anything. */
export class ClaudeParser {
  #session: string | null = null;
  #emittedText = false;
  #result: Outcome | undefined;
  #tools: ToolEvents;

  constructor(
    private readonly base: string,
    private readonly granted: Granted = [],
  ) {
    this.#tools = new ToolEvents("claude", base, granted);
  }

  feed(line: string): AgentEvent[] {
    let v: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      v = parsed;
    } catch {
      return [];
    }
    if (typeof v.session_id === "string") this.#session = v.session_id;
    const content = (m: unknown): Record<string, unknown>[] => {
      const c = (m as { content?: unknown } | undefined)?.content;
      return Array.isArray(c) ? c.filter((b) => b && typeof b === "object") : [];
    };
    switch (v.type) {
      case "stream_event":
        return this.#streamEvent((v.event ?? {}) as Record<string, unknown>);
      case "assistant":
        return content(v.message)
          .filter((b) => b.type === "tool_use")
          .flatMap((b) => {
            const name = typeof b.name === "string" ? b.name : "";
            return this.#tools.start(typeof b.id === "string" ? b.id : "", categoryOf(name), b.input, toolLabel(b, this.base, this.granted));
          });
      case "user":
        return content(v.message)
          .filter((b) => b.type === "tool_result")
          .flatMap((b) => {
            const failed = b.is_error === true;
            return this.#tools.end(typeof b.tool_use_id === "string" ? b.tool_use_id : "", failed ? "failed" : "success", failed ? "Tool reported an error" : undefined);
          });
      case "result": {
        const text = typeof v.result === "string" ? v.result : "";
        const isError = v.is_error === true || (typeof v.subtype === "string" && v.subtype !== "success");
        if (isError) {
          this.#result = { kind: "failed", message: text || `Claude Code stopped: ${typeof v.subtype === "string" ? v.subtype : "error"}.` };
          return [];
        }
        const out: AgentEvent[] = [];
        // No partial messages arrived: show the final text.
        if (!this.#emittedText && text) {
          this.#emittedText = true;
          out.push({ kind: "text", delta: text });
        }
        this.#result = { kind: "success", sessionId: this.#session };
        return out;
      }
      default:
        return [];
    }
  }

  #streamEvent(ev: Record<string, unknown>): AgentEvent[] {
    if (ev.type === "content_block_start" && (ev.content_block as { type?: unknown } | undefined)?.type === "text" && this.#emittedText) {
      // Separate text blocks (before and after a tool call) with a blank line.
      return [{ kind: "text", delta: "\n\n" }];
    }
    const delta = ev.delta as { type?: unknown; text?: unknown } | undefined;
    if (ev.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
      this.#emittedText = true;
      return [{ kind: "text", delta: delta.text }];
    }
    return [];
  }

  finish(): Outcome {
    return this.#result ?? { kind: "incomplete", message: "" };
  }
}

export const drive: Driver = async (gc, ctx, emit) => {
  const parser = new ClaudeParser(ctx.workingDir, ctx.granted);
  const aborted = abortion(ctx.run.abort.signal);
  const reading = readLines(gc.stdout, (line) => parser.feed(line).forEach(emit));
  // A descendant holding stdout open after the CLI exited can't hang the turn.
  const read = await Promise.race([reading.then(() => "eof" as const), gc.exited.then(() => sleep(1000)).then(() => "eof" as const), aborted]);
  if (read === "abort") {
    await stopGroup(gc, ctx.run);
    return "stopped";
  }
  // A stop that arrived meanwhile wins over the exit, as it did in the Rust core.
  const exited = ctx.run.abort.signal.aborted ? "abort" : await Promise.race([gc.exited.then(() => "exit" as const), aborted]);
  if (exited === "abort") {
    await stopGroup(gc, ctx.run);
    return "stopped";
  }
  return parser.finish();
};
