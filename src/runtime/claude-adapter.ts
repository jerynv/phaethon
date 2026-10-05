import type { ChatModelAdapter, ChatModelRunResult } from "@assistant-ui/react";
import { Channel, invoke } from "@tauri-apps/api/core";

import { inTauri } from "@/lib/tauri";

/** Mirrors `AgentEvent` in src-tauri/src/agent.rs. */
type AgentEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool"; label: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "cancelled" }
  | { kind: "end"; sessionId: string | null };

/** What the UI reads from `message.metadata.custom`. */
export type AgentMessageCustom = {
  /** Latest tool activity, e.g. "Reading file notes.md". */
  toolStatus?: string;
};

/** Stop the reply running in `spaceId`, if any. Safe to call when nothing runs or outside Tauri. */
export function cancelSpaceRun(spaceId: string): void {
  if (!inTauri()) return;
  void invoke("agent_cancel", { space: spaceId }).catch(() => {});
}

/** Minimal async queue: the Channel pushes, the generator pulls. */
function eventQueue() {
  const items: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  return {
    push(e: AgentEvent) {
      items.push(e);
      wake?.();
      wake = null;
    },
    async next(): Promise<AgentEvent> {
      while (items.length === 0) await new Promise<void>((r) => (wake = r));
      return items.shift()!;
    },
  };
}

/**
 * Streams replies from the `claude` CLI that the Rust core runs for `spaceId`.
 * Only the newest user message is sent: the CLI keeps the conversation itself
 * (resumed per space), so earlier turns are already on its side.
 */
export function createClaudeAdapter(spaceId: string): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const prompt =
        lastUser?.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("")
          .trim() ?? "";

      const queue = eventQueue();
      const channel = new Channel<AgentEvent>();
      channel.onmessage = (e) => queue.push(e);

      const onAbort = () => cancelSpaceRun(spaceId);
      abortSignal.addEventListener("abort", onAbort);

      // Every outcome arrives as events; a rejection here means the IPC call itself failed.
      invoke("agent_send", { space: spaceId, prompt, onEvent: channel }).catch((err: unknown) => {
        queue.push({ kind: "error", code: "ipc", message: `steward could not reach its backend: ${String(err)}` });
        queue.push({ kind: "end", sessionId: null });
      });

      let text = "";
      let toolStatus: string | undefined;
      const update = (): ChatModelRunResult => ({
        content: text ? [{ type: "text", text }] : [],
        metadata: { custom: { toolStatus } satisfies AgentMessageCustom },
      });

      try {
        for (;;) {
          const e = await queue.next();
          switch (e.kind) {
            case "text":
              text += e.delta;
              yield update();
              break;
            case "tool":
              toolStatus = e.label;
              yield update();
              break;
            case "error":
              toolStatus = undefined;
              yield {
                ...update(),
                status: { type: "incomplete", reason: "error", error: e.message },
              };
              break;
            case "cancelled":
              toolStatus = undefined;
              yield { ...update(), status: { type: "incomplete", reason: "cancelled" } };
              break;
            case "end":
              if (toolStatus !== undefined) {
                toolStatus = undefined;
                yield update();
              }
              return;
          }
        }
      } finally {
        abortSignal.removeEventListener("abort", onAbort);
      }
    },
  };
}
