import type {
  ChatModelAdapter,
  ChatModelRunResult,
  ThreadAssistantMessagePart,
  ThreadMessage,
} from "@assistant-ui/react";
import { Channel, invoke } from "@tauri-apps/api/core";

import { notifyGrantsChanged } from "@/lib/grants";
import { inTauri } from "@/lib/tauri";

/** Mirrors `AgentEvent` in src-tauri/src/agent.rs. */
type AgentEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool"; label: string }
  | { kind: "approval"; id: string; summary: string; detail: string }
  | { kind: "approvalDone"; id: string; allowed: boolean }
  | { kind: "accessRequest"; id: string; space: string; path: string; reason: string }
  | { kind: "accessRequestDone"; id: string; answer: AccessAnswer }
  | { kind: "error"; code: string; message: string }
  | { kind: "cancelled" }
  | { kind: "end"; sessionId: string | null };

/** What the UI reads from `message.metadata.custom`. */
export type AgentMessageCustom = {
  /** Latest tool activity, e.g. "Reading file notes.md". */
  toolStatus?: string;
  /** A write waiting for the user's answer (steward's own agent only). */
  approval?: PendingApproval;
  /** A read of another space waiting for the user's answer (steward's own agent only). */
  accessRequest?: PendingAccessRequest;
  /** The backend's error code when the reply failed (`ErrorCode` in agent.rs, or "ipc"). */
  errorCode?: string;
};

export type PendingApproval = { id: string; summary: string; detail: string };

/** How the user answers an access request (`AccessAnswer` in agent.rs). A cancelled request counts as "deny". */
export type AccessAnswer = "once" | "always" | "deny";

/** The agent asks to read `path` (relative, "" for the whole space) in the other space `space`. */
export type PendingAccessRequest = { id: string; space: string; path: string; reason: string };

/**
 * What was answered, kept in the reply as a data part where it happened, so the
 * conversation records what was granted ("Allowed once: Work / calendar").
 */
export type AccessReceipt = { id: string; space: string; path: string; answer: AccessAnswer };
export const ACCESS_RECEIPT_PART = "access-receipt";

/** One attachment as `agent_send` takes it (`Upload` in src-tauri/src/attachments.rs). */
export type AttachmentUpload = { name: string; mediaType: string; data: string };

/** The files on a user message, ready to send: base64 bytes with no `data:` prefix. */
export function uploadsOf(message: ThreadMessage | undefined): AttachmentUpload[] {
  if (!message || message.role !== "user") return [];
  const uploads: AttachmentUpload[] = [];
  for (const a of message.attachments ?? []) {
    for (const part of a.content) {
      if (part.type === "file" && part.data && !part.sourceType) {
        uploads.push({ name: part.filename ?? a.name, mediaType: part.mimeType, data: part.data });
      }
    }
  }
  return uploads;
}

/** Answer a pending write in `spaceId`. Resolves false if it is no longer waiting. */
export async function answerApproval(spaceId: string, id: string, allow: boolean): Promise<boolean> {
  return invoke<boolean>("agent_approve", { space: spaceId, id, allow });
}

/** Answer a pending access request in `spaceId`. Resolves false if it is no longer waiting. */
export async function answerAccess(spaceId: string, id: string, answer: AccessAnswer): Promise<boolean> {
  return invoke<boolean>("agent_access_answer", { space: spaceId, id, answer });
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
 * loop, or the `claude` CLI). Only the newest user message is sent, with its
 * attachments: the backend keeps the conversation itself, so earlier turns are
 * already on its side. The Rust core checks the files again and saves them into
 * the space; a refusal comes back as an `attachment` error.
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
      const attachments = uploadsOf(lastUser);

      const queue = eventQueue();
      const channel = new Channel<AgentEvent>();
      channel.onmessage = (e) => queue.push(e);

      const onAbort = () => cancelSpaceRun(spaceId);
      abortSignal.addEventListener("abort", onAbort);

      // Every outcome arrives as events; a rejection here means the IPC call itself failed.
      invoke("agent_send", { space: spaceId, prompt, attachments, onEvent: channel }).catch((err: unknown) => {
        queue.push({ kind: "error", code: "ipc", message: `steward could not reach its backend: ${String(err)}` });
        queue.push({ kind: "end", sessionId: null });
      });

      // Text, split wherever an access request was answered so its receipt sits
      // at that point in the reply.
      let parts: ThreadAssistantMessagePart[] = [];
      let toolStatus: string | undefined;
      let approval: PendingApproval | undefined;
      let accessRequest: PendingAccessRequest | undefined;
      let errorCode: string | undefined;
      const update = (): ChatModelRunResult => ({
        content: parts,
        metadata: { custom: { toolStatus, approval, accessRequest, errorCode } satisfies AgentMessageCustom },
      });
      const settle = () => {
        toolStatus = undefined;
        approval = undefined;
        accessRequest = undefined;
      };

      try {
        for (;;) {
          const e = await queue.next();
          switch (e.kind) {
            case "text": {
              const last = parts[parts.length - 1];
              parts =
                last?.type === "text"
                  ? [...parts.slice(0, -1), { type: "text", text: last.text + e.delta }]
                  : [...parts, { type: "text", text: e.delta }];
              yield update();
              break;
            }
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
            case "accessRequest":
              accessRequest = { id: e.id, space: e.space, path: e.path, reason: e.reason };
              yield update();
              break;
            case "accessRequestDone": {
              const asked = accessRequest?.id === e.id ? accessRequest : undefined;
              if (!asked) break;
              accessRequest = undefined;
              // "Waiting for you to answer: ..." is over; the receipt says what happened.
              if (toolStatus?.startsWith("Waiting for you")) toolStatus = undefined;
              const receipt: AccessReceipt = { id: e.id, space: asked.space, path: asked.path, answer: e.answer };
              parts = [...parts, { type: "data", id: e.id, name: ACCESS_RECEIPT_PART, data: receipt }];
              // A kept grant shows up in the title bar and Settings at once.
              if (e.answer === "always") notifyGrantsChanged();
              yield update();
              break;
            }
            case "error":
              settle();
              errorCode = e.code;
              yield {
                ...update(),
                status: { type: "incomplete", reason: "error", error: e.message },
              };
              break;
            case "cancelled":
              settle();
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
