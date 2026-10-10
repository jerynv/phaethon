import type {
  ChatModelAdapter,
  ChatModelRunResult,
  ThreadAssistantMessagePart,
  ThreadMessage,
} from "@assistant-ui/react";
import { Channel, invoke } from "@tauri-apps/api/core";

import { notifyGrantsChanged } from "@/lib/grants";
import { inTauri } from "@/lib/tauri";

import { RECORD_PART, loadUiThread, type AccessAnswer, type ChatRecord, type RecordPartData } from "./records";
import type { ThreadIndex } from "./thread-index";

export type { AccessAnswer } from "./records";

/** Mirrors `AgentEvent` in src-tauri/src/agent.rs (contracts.md). */
type AgentEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool"; label: string }
  | {
      kind: "approval";
      id: string;
      summary: string;
      detail: string;
      action?: "create" | "replace";
      path?: string;
      space?: string;
      before?: string | null;
      truncated?: boolean;
    }
  | { kind: "approvalDone"; id: string; allowed: boolean }
  | { kind: "accessRequest"; id: string; space: string; path: string; reason: string }
  | { kind: "accessRequestDone"; id: string; answer: AccessAnswer }
  | { kind: "record"; record: ChatRecord }
  | { kind: "error"; code: string; message: string; retryAfterSecs?: number }
  | { kind: "cancelled" }
  | { kind: "end"; sessionId: string | null };

/** What the UI reads from `message.metadata.custom`. */
export type AgentMessageCustom = {
  /** Latest tool activity, e.g. "Reading file notes.md". */
  toolStatus?: string;
  /** A write waiting for the user's answer (Phaethon's own agent only). */
  approval?: PendingApproval;
  /** A read of another space waiting for the user's answer (Phaethon's own agent only). */
  accessRequest?: PendingAccessRequest;
  /** The backend's error code when the reply failed (`ErrorCode` in agent.rs, or "ipc"). */
  errorCode?: string;
  /** With a rate limit: how long the provider asked to wait. */
  retryAfterSecs?: number;
  /** A saved message's position in thread.json (messages loaded from disk only). */
  index?: number;
};

/**
 * A write the agent wants to make. `detail` is the full new content and
 * `before` the full old content when replacing (null when creating); either is
 * cut at 512 KiB, and then `truncated` is set.
 */
export type PendingApproval = {
  id: string;
  summary: string;
  detail: string;
  action: "create" | "replace";
  path: string;
  space: string;
  before: string | null;
  truncated: boolean;
};

/** The agent asks to read `path` (relative, "" for the whole space) in the other space `space`. */
export type PendingAccessRequest = { id: string; space: string; path: string; reason: string };

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

/** A reloaded file's id carries where it is saved in the space, so an edit or regenerate can keep it. */
const SAVED_ATTACHMENT = "saved-file:";
export const savedAttachmentId = (path: string) => `${SAVED_ATTACHMENT}${path}`;

/** The saved paths of the reloaded files still on a user message (an edit may have removed some). */
export function keptPathsOf(message: ThreadMessage | undefined): string[] {
  if (!message || message.role !== "user") return [];
  return (message.attachments ?? []).filter((a) => a.id.startsWith(SAVED_ATTACHMENT)).map((a) => a.id.slice(SAVED_ATTACHMENT.length));
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

let recordSeq = 0;

/**
 * Streams replies from the agent the Rust core runs for `spaceId` (Phaethon's own
 * loop, or the `claude` CLI). Only the newest user message is sent, with its
 * attachments: the backend keeps the conversation itself, so earlier turns are
 * already on its side. An edit or a regenerate forks the thread: the backend
 * is told where (`replaceFrom`, the saved position of the replaced message),
 * keeps the old version in the space's archive, and answers the new one.
 */
export function createAgentAdapter(
  spaceId: string,
  threadIndex?: ThreadIndex,
  /** True once the conversation's view is gone (see onAbort below). */
  disposed: () => boolean = () => false,
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal, unstable_assistantMessageId, unstable_getMessage }) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const prompt =
        lastUser?.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("")
          .trim() ?? "";
      const attachments = uploadsOf(lastUser);
      // An edit or a regenerate: the shown thread before the newest user
      // message is shorter than (or differs from) the one shown last time.
      const fork = threadIndex?.forkPoint(messages.slice(0, -1).map((m) => m.id));
      const replaceFrom = typeof fork === "number" ? fork : undefined;

      const queue = eventQueue();
      const channel = new Channel<AgentEvent>();
      channel.onmessage = (e) => queue.push(e);

      // Stop (the button, Escape) aborts the run: stop it in the backend. The
      // runtime also aborts when its view goes away; leaving a space never
      // stops its reply (the backend finishes and saves it), unless a card was
      // waiting there, which nobody could answer any more.
      const onAbort = () =>
        setTimeout(() => {
          if (!disposed() || approval || accessRequest) cancelSpaceRun(spaceId);
        }, 0);
      abortSignal.addEventListener("abort", onAbort);

      // Every outcome arrives as events; a rejection here means the IPC call itself failed.
      const args: Record<string, unknown> = { space: spaceId, prompt, attachments, onEvent: channel };
      if (replaceFrom !== undefined) {
        args.replaceFrom = replaceFrom;
        // Files on the replaced message stay with it (a reloaded file has no bytes here to send again).
        args.keepAttachments = keptPathsOf(lastUser);
      }
      invoke("agent_send", args).catch((err: unknown) => {
        // The banner says what happened in plain words; this raw text goes under "Details".
        queue.push({ kind: "error", code: "ipc", message: String(err) });
        queue.push({ kind: "end", sessionId: null });
      });

      // Text, split wherever something was recorded (an answer, a read in
      // another space) so its receipt sits at that point in the reply.
      let parts: ThreadAssistantMessagePart[] = [];
      let toolStatus: string | undefined;
      let approval: PendingApproval | undefined;
      let accessRequest: PendingAccessRequest | undefined;
      let errorCode: string | undefined;
      let retryAfterSecs: number | undefined;
      const update = (): ChatModelRunResult => ({
        content: parts,
        metadata: {
          custom: { toolStatus, approval, accessRequest, errorCode, retryAfterSecs } satisfies AgentMessageCustom,
        },
      });
      const settle = () => {
        toolStatus = undefined;
        approval = undefined;
        accessRequest = undefined;
      };
      /** "Waiting for you to ..." is over once the card is answered. */
      const clearWaiting = () => {
        if (toolStatus?.startsWith("Waiting for you")) toolStatus = undefined;
      };

      try {
        for (;;) {
          const e = await queue.next();
          switch (e.kind) {
            case "text": {
              // Words after a tool line mean the tool is done: drop the stale
              // "Reading file ..." (a later tool event sets a new one).
              toolStatus = undefined;
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
              approval = {
                id: e.id,
                summary: e.summary,
                detail: e.detail,
                action: e.action ?? "create",
                path: e.path ?? "",
                space: e.space ?? spaceId,
                before: e.before ?? null,
                truncated: !!e.truncated,
              };
              yield update();
              break;
            case "approvalDone":
              if (approval?.id === e.id) {
                approval = undefined;
                clearWaiting();
              }
              yield update();
              break;
            case "accessRequest":
              accessRequest = { id: e.id, space: e.space, path: e.path, reason: e.reason };
              yield update();
              break;
            case "accessRequestDone":
              if (accessRequest?.id !== e.id) break;
              accessRequest = undefined;
              clearWaiting();
              // A kept grant shows up in the title bar and Settings at once.
              if (e.answer === "always") notifyGrantsChanged();
              yield update();
              break;
            case "record": {
              const data: RecordPartData = { id: `rec-${++recordSeq}`, record: e.record };
              parts = [...parts, { type: "data", name: RECORD_PART, data }];
              yield update();
              break;
            }
            case "error":
              settle();
              errorCode = e.code;
              retryAfterSecs = e.retryAfterSecs;
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
        if (threadIndex) {
          // The thread as shown now, matched against what the backend saved.
          let assistantId = unstable_assistantMessageId;
          try {
            assistantId ??= unstable_getMessage().id;
          } catch {
            // No message to read: keep the user side only.
          }
          const shown = messages.map((m) => ({ id: m.id, role: m.role as string }));
          if (assistantId) shown.push({ id: assistantId, role: "assistant" });
          const saved = await loadUiThread(spaceId).catch(() => null);
          threadIndex.settle(shown, saved);
        }
      }
    },
  };
}
