import { create } from "zustand";
import type { AccessAnswer, AgentEvent, LessonAnswer } from "#shared/agent.ts";
import { chatKey, DRAFT, openOf, useNav, useOpenThread } from "@/app/store";
import { Channel, errorText, onCoreStatus } from "@/lib/core";
import { invalidate } from "@/lib/query";
import * as chat from "./api";
import { applyEvent, continueReply, fromUi, mergeSaved, needsYou, newKey, startReply, type Attachment, type AssistantMessage, type Message } from "./lib/timeline";

/**
 * Every conversation as the timeline shows it, keyed by `chatKey(space,
 * thread)`, so any number of replies stream at once and switching
 * conversation, space or page never clears what is on screen: a conversation
 * that was shown before refreshes quietly in place. A turn's events arrive on
 * its own Channel and are folded into that conversation's last reply with the
 * tested `applyEvent`.
 *
 * A space's new chat lives under `DRAFT` until it is first sent: then the
 * core gives it an id (`thread_create`) and its state moves there, so
 * clicking New chat again and again leaves nothing behind.
 *
 * Actions take the space and, optionally, the conversation; without one they
 * act on the conversation the space shows (what the composer and the cards on
 * screen mean).
 */

export type ConvChat = {
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  messages: Message[];
  running: boolean;
  /** When the running reply started (for the elapsed counter). */
  startedAt?: number;
  pick?: chat.PickView;
  pickError?: string;
  /** Shown at least once: later loads refresh in place, without a skeleton. */
  loaded: boolean;
  /** Which load this state belongs to (stale loads are dropped). */
  epoch: number;
};

/** @deprecated The name from when there was one conversation per space. */
export type SpaceChat = ConvChat;

/** An edit of a sent message in progress (kept per conversation). */
export type EditDraft = { index: number; text: string; attachments: Attachment[] };

const EMPTY: ConvChat = { status: "idle", messages: [], running: false, loaded: false, epoch: 0 };

type SendInput = {
  prompt: string;
  uploads: chat.Upload[];
  shown: Attachment[];
  replaceFrom?: number;
  keepAttachments?: string[];
};

type Chats = {
  convs: Record<string, ConvChat>;
  edits: Record<string, EditDraft>;
  load(space: string, thread?: string): Promise<void>;
  send(space: string, input: SendInput, thread?: string): Promise<void>;
  resume(space: string, key: string, thread?: string): Promise<void>;
  stop(space: string, thread?: string): Promise<void>;
  approve(space: string, id: string, allow: boolean, remember?: chat.Remember, thread?: string): Promise<void>;
  answerAccess(space: string, id: string, answer: AccessAnswer, thread?: string): Promise<void>;
  answerLesson(space: string, id: string, answer: LessonAnswer, thread?: string): Promise<void>;
  setPick(space: string, pick: chat.ModelPick, thread?: string): Promise<void>;
  dismissError(space: string, key: string, thread?: string): void;
  setEdit(space: string, thread: string, edit: EditDraft | null): void;
};

/** The core's automatic title for a first message, so the new row reads right before the list catches up. */
function titleFrom(prompt: string, shown: Attachment[]): string {
  const collapsed = prompt.split(/\s+/).filter(Boolean).join(" ") || shown[0]?.name || "New conversation";
  const chars = [...collapsed];
  return chars.length <= 60 ? collapsed : chars.slice(0, 59).join("").trimEnd() + "…";
}

export const useChats = create<Chats>((set, get) => {
  const patch = (key: string, f: (c: ConvChat) => Partial<ConvChat>) =>
    set((s) => {
      const cur = s.convs[key] ?? EMPTY;
      return { convs: { ...s.convs, [key]: { ...cur, ...f(cur) } } };
    });

  /** Applies an event to the reply being written (the conversation's last message). */
  const onEvent = (key: string) => (e: AgentEvent) => {
    if (e.kind === "record") {
      // The agent changed something another screen may have cached.
      if (e.record.kind === "memory" || e.record.kind === "profile") invalidate("memory:");
      else if (e.record.kind === "person") invalidate("people:");
      else if (e.record.kind === "schedule") invalidate("jobs:");
    }
    patch(key, (c) => {
      const last = c.messages[c.messages.length - 1];
      if (!last || last.role !== "assistant") return {};
      const next = applyEvent(last, e);
      const done = e.kind === "end";
      return { messages: [...c.messages.slice(0, -1), next], ...(done ? { running: false, startedAt: undefined } : {}) };
    });
  };

  /** After a turn: positions from the saved file, the sidebar's row, and the unread mark. */
  const settle = async (space: string, thread: string) => {
    const key = chatKey(space, thread);
    try {
      const saved = await chat.threadLoad(space, thread);
      patch(key, (c) => (c.running ? {} : { messages: mergeSaved(c.messages, saved) }));
    } catch {
      // What's on screen stays; the next load reads the file again.
    }
    // Only this conversation's row changes; the rest of the list is left as it is.
    void useNav.getState().refreshThread(space, thread).catch(() => {});
    useNav.getState().replied(space, thread);
  };

  /**
   * Runs one streamed call. The turn is over when its `end` event arrives
   * (the call itself may resolve earlier or later), or when the call fails.
   */
  const stream = async (space: string, thread: string, start: (ch: Channel<AgentEvent>) => Promise<unknown>) => {
    const key = chatKey(space, thread);
    const apply = onEvent(key);
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
      patch(key, () => ({ running: false, startedAt: undefined }));
      await settle(space, thread);
    }
  };

  const loadPick = async (space: string, thread: string) => {
    const key = chatKey(space, thread);
    try {
      const pick = await chat.threadModelGet(space, thread === DRAFT ? null : thread);
      patch(key, () => ({ pick, pickError: undefined }));
    } catch (e) {
      patch(key, () => ({ pickError: errorText(e) }));
    }
  };

  return {
    convs: {},
    edits: {},

    async load(space, thread = openOf(space)) {
      const key = chatKey(space, thread);
      const cur = get().convs[key] ?? EMPTY;
      if (thread === DRAFT) {
        if (!cur.loaded) patch(key, () => ({ status: "ready", loaded: true }));
        await loadPick(space, thread);
        return;
      }
      // A reply streaming here owns the messages; only the model is refreshed.
      if (cur.running) {
        if (!cur.pick) await loadPick(space, thread);
        return;
      }
      const epoch = cur.epoch + 1;
      patch(key, (c) => ({ epoch, ...(c.loaded ? {} : { status: "loading", error: undefined }) }));
      const [msgs, pick] = await Promise.allSettled([chat.threadLoad(space, thread), chat.threadModelGet(space, thread)]);
      if ((get().convs[key]?.epoch ?? 0) !== epoch) return;
      patch(key, (c) => {
        const out: Partial<ConvChat> = {
          pick: pick.status === "fulfilled" ? pick.value : c.pick,
          pickError: pick.status === "rejected" ? errorText(pick.reason) : undefined,
        };
        if (msgs.status === "fulfilled") {
          out.status = "ready";
          out.error = undefined;
          out.loaded = true;
          out.messages = c.running ? mergeSaved(c.messages, msgs.value, true) : c.loaded ? mergeSaved(c.messages, msgs.value) : fromUi(msgs.value);
        } else if (!c.loaded) {
          out.status = "error";
          out.error = errorText(msgs.reason);
        }
        return out;
      });
    },

    async send(space, input, thread = openOf(space)) {
      let key = chatKey(space, thread);
      const cur = get().convs[key] ?? EMPTY;
      if (cur.running) return;
      const user: Message = { role: "user", key: newKey("u"), text: input.prompt, attachments: input.shown, at: Date.now() };
      // Editing or retrying cuts the conversation at that message, unsaved replies after it included.
      const cut = input.replaceFrom === undefined ? -1 : cur.messages.findIndex((m) => m.index !== undefined && m.index >= input.replaceFrom!);
      const base = cut >= 0 ? cur.messages.slice(0, cut) : cur.messages;
      patch(key, () => ({ messages: [...base, user, startReply()], running: true, startedAt: Date.now(), status: "ready", loaded: true }));

      if (thread === DRAFT) {
        // The new chat becomes a conversation now that it has something in it.
        let id: string;
        try {
          id = await chat.threadCreate(space);
        } catch (e) {
          const apply = onEvent(key);
          apply({ kind: "error", code: "storage", message: errorText(e) });
          apply({ kind: "end", sessionId: null });
          patch(key, () => ({ running: false, startedAt: undefined }));
          return;
        }
        const moved = get().convs[key]!;
        const next = chatKey(space, id);
        set((s) => ({ convs: { ...s.convs, [next]: moved, [key]: { ...EMPTY, status: "ready", loaded: true, pick: moved.pick } } }));
        useNav.getState().adoptDraft(space, id, titleFrom(input.prompt, input.shown));
        thread = id;
        key = next;
      } else {
        useNav.getState().bumpThread(space, thread);
      }

      const target = thread;
      await stream(space, target, (ch) =>
        chat.agentSend({
          space,
          thread: target,
          prompt: input.prompt,
          attachments: input.uploads,
          onEvent: ch,
          replaceFrom: input.replaceFrom,
          keepAttachments: input.keepAttachments,
          model: cur.pick?.pick,
        }),
      );
    },

    async resume(space, key, thread = openOf(space)) {
      const ck = chatKey(space, thread);
      const cur = get().convs[ck] ?? EMPTY;
      const at = cur.messages.findIndex((m) => m.key === key);
      const m = cur.messages[at];
      if (thread === DRAFT || cur.running || !m || m.role !== "assistant" || m.index === undefined) return;
      const from = m.index;
      patch(ck, (c) => ({ messages: [...c.messages.slice(0, at), continueReply(m as AssistantMessage), ...c.messages.slice(at + 1)], running: true, startedAt: Date.now() }));
      await stream(space, thread, (ch) => chat.agentSend({ space, thread, prompt: "", attachments: [], onEvent: ch, continueFrom: from }));
    },

    async stop(space, thread = openOf(space)) {
      if (thread === DRAFT) return;
      try {
        await chat.agentCancel(space, thread);
      } catch {
        // The turn may have just ended.
      }
    },

    async approve(space, id, allow, remember, thread = openOf(space)) {
      await chat.agentApprove(space, thread, id, allow, remember);
    },

    async answerAccess(space, id, answer, thread = openOf(space)) {
      await chat.agentAccessAnswer(space, thread, id, answer);
    },

    async answerLesson(space, id, answer, thread = openOf(space)) {
      const key = chatKey(space, thread);
      const cur = get().convs[key] ?? EMPTY;
      if (cur.running || thread === DRAFT) return;
      // The question moves into the record; the continuation streams as a new reply.
      patch(key, (c) => ({
        messages: [...c.messages.map((m) => (m.role === "assistant" && m.question?.question.id === id ? { ...m, question: undefined } : m)), startReply()],
        running: true,
        startedAt: Date.now(),
      }));
      await stream(space, thread, (ch) => chat.lessonAnswer(space, thread, id, answer, ch));
    },

    async setPick(space, pick, thread = openOf(space)) {
      const key = chatKey(space, thread);
      const prev = get().convs[key]?.pick;
      patch(key, () => ({ pick: { pick, saved: true }, pickError: undefined }));
      try {
        const view = await chat.threadModelSet(space, thread === DRAFT ? null : thread, pick);
        // A new chat keeps its choice locally until it is sent (the core only remembers it as the default).
        patch(key, () => ({ pick: thread === DRAFT ? { pick, saved: true } : view }));
      } catch (e) {
        patch(key, () => ({ pick: prev, pickError: errorText(e) }));
        throw e;
      }
    },

    dismissError(space, key, thread = openOf(space)) {
      patch(chatKey(space, thread), (c) => ({ messages: c.messages.map((m) => (m.key === key && m.role === "assistant" ? { ...m, error: undefined } : m)) }));
    },

    setEdit(space, thread, edit) {
      const key = chatKey(space, thread);
      set((s) => {
        const { [key]: _, ...rest } = s.edits;
        return { edits: edit ? { ...rest, [key]: edit } : rest };
      });
    },
  };
});

/** One conversation's state. */
export function useConv(space: string | null | undefined, thread: string): ConvChat {
  return useChats((s) => (space ? (s.convs[chatKey(space, thread)] ?? EMPTY) : EMPTY));
}

/** The state of the conversation `space` shows. */
export function useSpaceChat(space: string | null | undefined): ConvChat {
  return useConv(space, useOpenThread(space));
}

/** What the sidebar marks on a conversation: replying, waiting on you, or its last reply failed. */
export type ConvState = "working" | "waiting" | "failed" | null;

export function convState(c: ConvChat | undefined): ConvState {
  if (!c) return null;
  const last = c.messages[c.messages.length - 1];
  if (needsYou(last)) return "waiting";
  if (c.running) return "working";
  if (last?.role === "assistant" && last.status === "failed") return "failed";
  return null;
}

export function useConvState(space: string, thread: string): ConvState {
  return useChats((s) => convState(s.convs[chatKey(space, thread)]));
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__phaethon = { ...(window.__phaethon ?? {}), chats: useChats };
}
