import type { ChatModelAdapter, ChatModelRunResult } from "@assistant-ui/react";
import { Channel, invoke } from "@tauri-apps/api/core";

import { inTauri } from "@/lib/tauri";

/** Mirrors `AgentEvent` in src-tauri/src/agent.rs. */
type AgentEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool"; label: string }
  | { kind: "approval"; id: string; summary: string; detail: string }
  | { kind: "approvalDone"; id: string; allowed: boolean }
  | { kind: "error"; code: string; message: string }
  | { kind: "cancelled" }
  | { kind: "end"; sessionId: string | null };

/** What the UI reads from `message.metadata.custom`. */
export type AgentMessageCustom = {
  /** Latest tool activity, e.g. "Reading file notes.md". */
  toolStatus?: string;
  /** A write waiting for the user's answer (steward's own agent only). */
  approval?: PendingApproval;
};

export type PendingApproval = { id: string; summary: string; detail: string };

/** Answer a pending write in `spaceId`. Resolves false if it is no longer waiting. */
export async function answerApproval(spaceId: string, id: string, allow: boolean): Promise<boolean> {
  return invoke<boolean>("agent_approve", { space: spaceId, id, allow });
}

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
 * Streams replies from the agent the Rust core runs for `spaceId` (steward's own
 * loop, or the `claude` CLI). Only the newest user message is sent: the backend
 * keeps the conversation itself, so earlier turns are already on its side.
 */
export function createAgentAdapter(spaceId: string): ChatModelAdapter {
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
      let approval: PendingApproval | undefined;
      const update = (): ChatModelRunResult => ({
        content: text ? [{ type: "text", text }] : [],
        metadata: { custom: { toolStatus, approval } satisfies AgentMessageCustom },
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
            case "approval":
              approval = { id: e.id, summary: e.summary, detail: e.detail };
              yield update();
              break;
            case "approvalDone":
              if (approval?.id === e.id) approval = undefined;
              yield update();
              break;
            case "error":
              toolStatus = undefined;
              approval = undefined;
              yield {
                ...update(),
                status: { type: "incomplete", reason: "error", error: e.message },
              };
              break;
            case "cancelled":
              toolStatus = undefined;
              approval = undefined;
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
