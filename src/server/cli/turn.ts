// STUB: owned by cli
import type { AgentEvent } from "../../shared/agent.ts";
import type { Channel } from "../rpc/channel.ts";
import type { Run } from "../core/runs.ts";
import type { Block } from "../core/thread.ts";

export type CliTurnRequest = {
  cli: "claude" | "codex" | "gemini";
  space: string;
  spaceDir: string;
  workingDir: string | null;
  prompt: string;
  attachments: Block[];
  replaceFrom?: number;
  configDir: string | null;
  addDirs: { label: string; path: string }[];
  model: string | null;
  reasoning?: string | null;
  fullAccess: boolean;
};

export async function runCliTurn(_req: CliTurnRequest, events: Channel<AgentEvent>, _run: Run): Promise<void> {
  events.send({ kind: "error", code: "missingCli", message: "CLI backends aren’t available in this build yet." });
  events.send({ kind: "end", sessionId: null });
}
