import { create } from "zustand";
import type { AccessAnswer, AgentEvent, LessonAnswer } from "#shared/agent.ts";
import { useNav } from "@/app/store";
import { Channel, errorText, onCoreStatus } from "@/lib/core";
import * as chat from "./api";
import { applyEvent, continueReply, fromUi, mergeSaved, newKey, startReply, type Attachment, type AssistantMessage, type Message } from "./lib/timeline";

/**
 * Each space's conversation as the timeline shows it, kept per space so a
 * reply keeps streaming while the user looks at another space. A turn's
 * events arrive on its own Channel and are folded into the last reply with
 * the tested `applyEvent`.
 */

export type SpaceChat = {
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  messages: Message[];
  running: boolean;
  /** When the running reply started (for the elapsed counter). */
  startedAt?: number;
  pick?: chat.PickView;
  pickError?: string;
  /** Which load this state belongs to (stale loads are dropped). */
  epoch: number;
};

const EMPTY: SpaceChat = { status: "idle", messages: [], running: false, epoch: 0 };

type SendInput = {
  prompt: string;
  uploads: chat.Upload[];
  shown: Attachment[];
  replaceFrom?: number;
  keepAttachments?: string[];
};

type Chats = {
  bySpace: Record<string, SpaceChat>;
  load(space: string): Promise<void>;
  send(space: string, input: SendInput): Promise<void>;
  resume(space: string, key: string): Promise<void>;
  stop(space: string): Promise<void>;
  approve(space: string, id: string, allow: boolean): Promise<void>;
  answerAccess(space: string, id: string, answer: AccessAnswer): Promise<void>;
  answerLesson(space: string, id: string, answer: LessonAnswer): Promise<void>;
  setPick(space: string, pick: chat.ModelPick): Promise<void>;
  dismissError(space: string, key: string): void;
};

export const useChats = create<Chats>((set, get) => {
  const patch = (space: string, f: (c: SpaceChat) => Partial<SpaceChat>) =>
    set((s) => {
      const cur = s.bySpace[space] ?? EMPTY;
      return { bySpace: { ...s.bySpace, [space]: { ...cur, ...f(cur) } } };
    });

  /** Applies an event to the reply being written (the last message). */
  const onEvent = (space: string) => (e: AgentEvent) =>
    patch(space, (c) => {
      const last = c.messages[c.messages.length - 1];
      if (!last || last.role !== "assistant") return {};
      const next = applyEvent(last, e);
      const done = e.kind === "end";
      return { messages: [...c.messages.slice(0, -1), next], ...(done ? { running: false, startedAt: undefined } : {}) };
    });

  /** After a turn: positions from the saved file, and the sidebar's titles. */
  const settle = async (space: string) => {
    try {
      const saved = await chat.threadLoad(space);
      patch(space, (c) => ({ messages: mergeSaved(c.messages, saved) }));
    } catch {
      // What's on screen stays; the next load reads the file again.
    }
    void useNav.getState().loadThreads(space);
  };

  /**
   * Runs one streamed call. The turn is over when its `end` event arrives
   * (the call itself may resolve earlier or later), or when the call fails.
   */
  const stream = async (space: string, start: (ch: Channel<AgentEvent>) => Promise<unknown>) => {
    const apply = onEvent(space);
    let ended!: () => void;
    const end = new Promise<void>((r) => (ended = r));
    const ch = new Channel<AgentEvent>((e) => {
      apply(e);
      if (e.kind === "end") ended();
    });
    // Streams can't survive a lost connection; the turn is shown as failed rather than left hanging.
    const unwatch = onCoreStatus((st) => {
      if (st !== "lost") return;
      apply({ kind: "error", code: "ipc", message: "The connection to Phaethon’s core dropped during this reply." } as unknown as AgentEvent);
      ended();
    });
    try {
      await start(ch);
      await end;
    } catch (e) {
      apply({ kind: "error", code: "provider", message: errorText(e) });
      apply({ kind: "end", sessionId: null });
    } finally {
      unwatch();
      ch.close();
      patch(space, () => ({ running: false, startedAt: undefined }));
      await settle(space);
    }
  };

  return {
    bySpace: {},

    async load(space) {
      const epoch = (get().bySpace[space]?.epoch ?? 0) + 1;
      patch(space, (c) => ({ status: "loading", error: undefined, epoch, messages: c.running ? c.messages : [] }));
      const [msgs, pick] = await Promise.allSettled([chat.threadLoad(space), chat.threadModelGet(space)]);
      if ((get().bySpace[space]?.epoch ?? 0) !== epoch) return;
      patch(space, (c) => ({
        status: msgs.status === "fulfilled" ? "ready" : "error",
        error: msgs.status === "rejected" ? errorText(msgs.reason) : undefined,
        messages: msgs.status === "fulfilled" ? (c.running ? mergeSaved(c.messages, msgs.value, true) : fromUi(msgs.value)) : c.messages,
        pick: pick.status === "fulfilled" ? pick.value : c.pick,
        pickError: pick.status === "rejected" ? errorText(pick.reason) : undefined,
      }));
    },

    async send(space, input) {
      const cur = get().bySpace[space] ?? EMPTY;
      if (cur.running) return;
      const user: Message = { role: "user", key: newKey("u"), text: input.prompt, attachments: input.shown, at: Date.now() };
      // Editing or retrying cuts the conversation at that message, unsaved replies after it included.
      const cut = input.replaceFrom === undefined ? -1 : cur.messages.findIndex((m) => m.index !== undefined && m.index >= input.replaceFrom!);
      const base = cut >= 0 ? cur.messages.slice(0, cut) : cur.messages;
      patch(space, () => ({ messages: [...base, user, startReply()], running: true, startedAt: Date.now(), status: "ready" }));
      await stream(space, (ch) =>
        chat.agentSend({
          space,
          prompt: input.prompt,
          attachments: input.uploads,
          onEvent: ch,
          replaceFrom: input.replaceFrom,
          keepAttachments: input.keepAttachments,
          model: cur.pick?.pick,
        }),
      );
    },

    async resume(space, key) {
      const cur = get().bySpace[space] ?? EMPTY;
      const at = cur.messages.findIndex((m) => m.key === key);
      const m = cur.messages[at];
      if (cur.running || !m || m.role !== "assistant" || m.index === undefined) return;
      const from = m.index;
      patch(space, (c) => ({ messages: [...c.messages.slice(0, at), continueReply(m as AssistantMessage), ...c.messages.slice(at + 1)], running: true, startedAt: Date.now() }));
      await stream(space, (ch) => chat.agentSend({ space, prompt: "", attachments: [], onEvent: ch, continueFrom: from }));
    },

    async stop(space) {
      try {
        await chat.agentCancel(space);
      } catch {
        // The turn may have just ended.
      }
    },

    async approve(space, id, allow) {
      await chat.agentApprove(space, id, allow);
    },

    async answerAccess(space, id, answer) {
      await chat.agentAccessAnswer(space, id, answer);
    },

    async answerLesson(space, id, answer) {
      const cur = get().bySpace[space] ?? EMPTY;
      if (cur.running) return;
      // The question moves into the record; the continuation streams as a new reply.
      patch(space, (c) => ({
        messages: [...c.messages.map((m) => (m.role === "assistant" && m.question?.question.id === id ? { ...m, question: undefined } : m)), startReply()],
        running: true,
        startedAt: Date.now(),
      }));
      await stream(space, (ch) => chat.lessonAnswer(space, id, answer, ch));
    },

    async setPick(space, pick) {
      const prev = get().bySpace[space]?.pick;
      patch(space, () => ({ pick: { pick, saved: true }, pickError: undefined }));
      try {
        const view = await chat.threadModelSet(space, pick);
        patch(space, () => ({ pick: view }));
      } catch (e) {
        patch(space, () => ({ pick: prev, pickError: errorText(e) }));
        throw e;
      }
    },

    dismissError(space, key) {
      patch(space, (c) => ({ messages: c.messages.map((m) => (m.key === key && m.role === "assistant" ? { ...m, error: undefined } : m)) }));
    },
  };
});

export function useSpaceChat(space: string | null | undefined): SpaceChat {
  return useChats((s) => (space ? (s.bySpace[space] ?? EMPTY) : EMPTY));
}
