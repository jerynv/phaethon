import type { AgentEvent } from "../../shared/agent.ts";
import type { Run } from "../core/runs.ts";
import type { CliId, Outcome } from "./cli.ts";
import type { CliCommand } from "./instances.ts";
import { exitWithin, stopGroup, type GroupChild } from "./process.ts";
import type { Granted } from "./tools.ts";

/** Everything one run of a CLI needs, whichever CLI it is. */
export type DriveContext = {
  cli: CliId;
  space: string;
  spaceDir: string;
  workingDir: string;
  /** The spawn recipe (instance binary, instance args, env). */
  cmd: CliCommand;
  /** The binary the recipe was built for (Codex's own install dirs are readable). */
  bin: string;
  /** What the CLI is asked: the user's message (with the conversation so far on a fresh session). */
  prompt: string;
  /** Text added to the CLI's system prompt (see prompt.ts `systemText`). */
  mode: string;
  resume: string | null;
  model: string | null;
  reasoning: string | null;
  /** Folders the CLI may read besides the working folder. */
  dirs: string[];
  fullAccess: boolean;
  /** Labels for paths in other spaces' granted folders. */
  granted: Granted;
  run: Run;
};

/** How a CLI is launched for one turn. Throwing an Error gives a `cli` error and nothing is sent. */
export type Invocation = { args: string[]; input?: string; env?: Record<string, string> };

/** Drives a started CLI to the end of its turn; "stopped" once the run was cancelled and the group is gone. */
export type Driver = (gc: GroupChild, ctx: DriveContext, emit: (e: AgentEvent) => void) => Promise<"stopped" | Outcome>;

/** Resolves when `signal` aborts. */
export function abortion(signal: AbortSignal): Promise<"abort"> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve("abort");
    else signal.addEventListener("abort", () => resolve("abort"), { once: true });
  });
}

/**
 * Ends a long-lived protocol child (app-server, ACP agent) after its turn:
 * closes its stdin so it can shut down cleanly, gives it a moment, then stops
 * the whole group.
 */
export async function finishChild(gc: GroupChild, run: Run, graceMs = 1500): Promise<void> {
  try {
    gc.stdin?.end();
  } catch {
    // already closed
  }
  await exitWithin(gc, graceMs);
  await stopGroup(gc, run);
}
