/**
 * One conversation store per space, kept for the whole session: a reply
 * keeps streaming (and a card keeps waiting) while the person looks at
 * another space, and is all there when they come back.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";

import type { AccessAnswer, AgentEvent, LessonAnswer } from "#shared/agent.ts";
import { useNav } from "@/app/nav";
import { Channel, errorText } from "@/lib/core";
import * as api from "./api";
import { toBase64 } from "./lib/attachments";
import { spokenReply } from "./lib/spoken";
import {
  applyEvent,
  continueReply,
  fromUi,
  isStopped,
  mergeSaved,
  needsYou,
  newKey,
  replyText,
  startReply,
  type AssistantMessage,
  type Attachment,
  type Message,
  type UserMessage,
} from "./lib/timeline";

export type Draft = { id: string; file: File; name: string; mediaType: string; size: number; previewUrl?: string };

export type ChatState = {
  space: string;
  messages: Message[];
  status: "idle" | "loading" | "ready" | "error";
  loadError?: string;
  /** The thread version last loaded (nav.threadVersion). */
  loadedVersion: number;
  running: boolean;
  /** Said once through the polite live region; `n` makes a repeat count as new. */
  announcement: { text: string; n: number };
  /** Bumped when focus should return to the composer (after send, stop, answering a card). */
  focusComposer: number;
  load(version: number): Promise<void>;
  send(text: string, drafts: Draft[]): Promise<void>;
  stop(): Promise<void>;
  edit(key: string, text: string): Promise<void>;
  regenerate(): Promise<void>;
  /** Sends the last message again: in place when it was saved, else as new. */
  retry(): Promise<void>;
  continueLast(): Promise<void>;
  answerApproval(id: string, allow: boolean): Promise<string | null>;
  answerAccess(id: string, answer: AccessAnswer): Promise<string | null>;
  answerQuestion(id: string, answer: LessonAnswer): Promise<string | null>;
  announce(text: string): void;
};

/** Files of messages sent this session, so a failed send can be sent again with them. */
const sentFiles = new Map<string, Draft[]>();

const stores = new Map<string, UseBoundStore<StoreApi<ChatState>>>();

export function chatStore(space: string): UseBoundStore<StoreApi<ChatState>> {
  let s = stores.get(space);
  if (!s) {
    s = createChatStore(space);
    stores.set(space, s);
  }
  return s;
}

function lastReply(messages: Message[]): AssistantMessage | undefined {
  const last = messages[messages.length - 1];
  return last?.role === "assistant" ? last : undefined;
}

function createChatStore(space: string) {
  return create<ChatState>((set, get) => {
    let n = 0;
    const announce = (text: string) => set({ announcement: { text, n: ++n } });

    const syncActivity = () => {
      const { running, messages } = get();
      const waiting = needsYou(messages[messages.length - 1]);
      useNav.getState().setActivity(space, waiting ? "needsYou" : running ? "answering" : undefined);
    };

    /** Replaces the last reply with `fn(reply)`. */
    const updateReply = (fn: (m: AssistantMessage) => AssistantMessage) =>
      set((s) => {
        const last = lastReply(s.messages);
        if (!last) return s;
        return { messages: [...s.messages.slice(0, -1), fn(last)] };
      });

    /**
     * Runs one turn: `start` calls the core with a Channel; events update the
     * last reply, batched per frame; `end` settles it, reloads the saved
     * positions and tells the sidebar.
     */
    const runTurn = async (start: (ch: Channel<AgentEvent>) => Promise<unknown>, opening = "Sent. Phaethon is working on a reply.") => {
      const channel = new Channel<AgentEvent>();
      let queue: AgentEvent[] = [];
      let frame = 0;
      let ended = false;
      let sawEvent = false;
      const flush = () => {
        frame = 0;
        const batch = queue;
        queue = [];
        if (!batch.length) return;
        updateReply((m) => batch.reduce((acc, e) => applyEvent(acc, e), m));
        // A kept grant shows in Settings › Spaces at once.
        if (batch.some((e) => e.kind === "accessRequestDone" && e.answer === "always")) {
          window.dispatchEvent(new CustomEvent("phaethon:grants-changed"));
        }
        if (batch.some((e) => e.kind === "end")) finish();
        else syncActivity();
      };
      const finish = () => {
        if (ended) return;
        ended = true;
        channel.close();
        set({ running: false });
        const reply = lastReply(get().messages);
        if (reply) {
          if (reply.status === "done" && !reply.question) {
            const words = replyText(reply);
            const fresh = reply.continuedAfter !== undefined ? words.slice(reply.continuedAfter).trim() : words;
            const lead = reply.continuedAfter !== undefined ? "Phaethon continued" : "Phaethon replied";
            announce(fresh ? `${lead}: ${spokenReply(fresh)}` : "Phaethon finished without a reply.");
          } else if (reply.status === "done" && reply.question) {
            announce("Phaethon asked you a question. It’s below the conversation.");
          } else if (isStopped(reply)) {
            announce("Reply stopped.");
          }
        }
        syncActivity();
        useNav.getState().bumpThreadList();
        void api.threadLoad(space).then(
          (saved) => {
            if (get().running) return;
            const failed = lastReply(get().messages)?.status === "failed";
            set((s) => ({ messages: mergeSaved(s.messages, saved, failed) }));
            syncActivity();
          },
          () => {},
        );
      };
      channel.onmessage = (e) => {
        sawEvent = true;
        queue.push(e);
        if (!frame) frame = requestAnimationFrame(flush);
      };
      set({ running: true });
      announce(opening);
      syncActivity();
      try {
        await start(channel);
        // A command that ran without streaming (or a core that ignored the
        // channel): give stray events a moment, then settle from the saved thread.
        if (!sawEvent) {
          await new Promise((r) => setTimeout(r, 1500));
          if (!sawEvent && !ended) {
            queue.push({ kind: "end", sessionId: null });
            flush();
          }
        }
      } catch (err) {
        if (ended) return;
        queue.push({ kind: "error", code: "ipc", message: errorText(err) } as unknown as AgentEvent, { kind: "end", sessionId: null });
        flush();
      }
    };

    const uploads = (drafts: Draft[]) =>
      Promise.all(drafts.map(async (d) => ({ name: d.name, mediaType: d.mediaType, data: await toBase64(d.file) })));

    const userMessage = (text: string, attachments: Attachment[]): UserMessage => ({
      role: "user",
      key: newKey("u"),
      text,
      attachments,
      at: Date.now(),
    });

    return {
      space,
      messages: [],
      status: "idle",
      loadedVersion: -1,
      running: false,
      announcement: { text: "", n: 0 },
      focusComposer: 0,
      announce,

      async load(version) {
        if (get().running) return;
        set({ status: get().messages.length ? get().status : "loading", loadedVersion: version });
        try {
          const saved = await api.threadLoad(space);
          if (get().running) return;
          set({ messages: fromUi(saved), status: "ready", loadError: undefined });
        } catch (e) {
          set({ status: "error", loadError: errorText(e) });
        }
        syncActivity();
      },

      async send(text, drafts) {
        if (get().running) return;
        const prompt = text.trim();
        if (!prompt && !drafts.length) return;
        const attachments = drafts.map((d) => ({ name: d.name, mediaType: d.mediaType, size: d.size, previewUrl: d.previewUrl }));
        const user = userMessage(prompt, attachments);
        if (drafts.length) sentFiles.set(user.key, drafts);
        set((s) => ({ messages: [...s.messages, user, startReply()], focusComposer: s.focusComposer + 1 }));
        let files: api.Upload[];
        try {
          files = await uploads(drafts);
        } catch (e) {
          updateReply((m) => ({ ...m, status: "failed", error: { code: "attachment", message: errorText(e) } }));
          return;
        }
        await runTurn((ch) => api.agentSend({ space, prompt, attachments: files, onEvent: ch }));
      },

      async stop() {
        if (!get().running) return;
        set((s) => ({ focusComposer: s.focusComposer + 1 }));
        try {
          await api.agentCancel(space);
        } catch {
          // The turn ends on its own; nothing else to do.
        }
      },

      async edit(key, text) {
        if (get().running) return;
        const at = get().messages.findIndex((m) => m.key === key);
        const old = get().messages[at];
        if (!old || old.role !== "user" || old.index === undefined) return;
        const kept = old.attachments.filter((a) => a.path).map((a) => a.path!);
        const next: UserMessage = { ...userMessage(text.trim(), old.attachments) };
        set((s) => ({ messages: [...s.messages.slice(0, at), next, startReply()], focusComposer: s.focusComposer + 1 }));
        await runTurn((ch) =>
          api.agentSend({ space, prompt: text.trim(), attachments: [], onEvent: ch, replaceFrom: old.index, keepAttachments: kept }),
        );
      },

      async regenerate() {
        if (get().running) return;
        const msgs = get().messages;
        let u = msgs.length - 1;
        while (u >= 0 && msgs[u].role !== "user") u--;
        const user = msgs[u];
        if (!user || user.role !== "user" || user.index === undefined) return;
        const kept = user.attachments.filter((a) => a.path).map((a) => a.path!);
        set((s) => ({ messages: [...s.messages.slice(0, u + 1), startReply()], focusComposer: s.focusComposer + 1 }));
        await runTurn((ch) =>
          api.agentSend({ space, prompt: user.text, attachments: [], onEvent: ch, replaceFrom: user.index, keepAttachments: kept }),
        );
      },

      async retry() {
        if (get().running) return;
        const msgs = get().messages;
        let u = msgs.length - 1;
        while (u >= 0 && msgs[u].role !== "user") u--;
        const user = msgs[u];
        if (!user || user.role !== "user") return;
        if (user.index !== undefined) return get().regenerate();
        set({ messages: msgs.slice(0, u) });
        await get().send(user.text, sentFiles.get(user.key) ?? []);
      },

      async continueLast() {
        if (get().running) return;
        const reply = lastReply(get().messages);
        if (!reply || reply.index === undefined || !isStopped(reply)) return;
        const from = reply.index;
        set((s) => ({ messages: [...s.messages.slice(0, -1), continueReply(reply)], focusComposer: s.focusComposer + 1 }));
        await runTurn((ch) => api.agentSend({ space, prompt: "", attachments: [], onEvent: ch, continueFrom: from }), "Continuing the reply.");
      },

      async answerApproval(id, allow) {
        try {
          const ok = await api.agentApprove(space, id, allow);
          if (!ok) return "This request has ended. Nothing was changed.";
        } catch (e) {
          return `Your answer couldn’t be sent, so nothing was changed. Stop the reply, then send your message again. (${errorText(e)})`;
        }
        announce(allow ? "Allowed." : "Not allowed.");
        set((s) => ({ focusComposer: s.focusComposer + 1 }));
        return null;
      },

      async answerAccess(id, answer) {
        try {
          const ok = await api.agentAccessAnswer(space, id, answer);
          if (!ok) return "This request has ended. Nothing was shared.";
        } catch (e) {
          return `Your answer couldn’t be sent, so nothing was shared. Stop the reply, then send your message again. (${errorText(e)})`;
        }
        announce(answer === "deny" ? "Not allowed." : answer === "always" ? "Always allowed." : "Allowed for this reply.");
        set((s) => ({ focusComposer: s.focusComposer + 1 }));
        return null;
      },

      async answerQuestion(id, answer) {
        const reply = lastReply(get().messages);
        if (!reply?.question || reply.question.question.id !== id) return "This question has ended.";
        const midTurn = get().running;
        // The card closes at once; the lesson carries on in the same reply.
        updateReply((m) => ({ ...m, question: undefined, status: "streaming", live: true, joinNext: true, continuedAfter: replyText(m).length }));
        set((s) => ({ focusComposer: s.focusComposer + 1 }));
        if (midTurn) {
          // The turn is still open: the rest of it arrives on its own channel.
          const unused = new Channel<AgentEvent>();
          try {
            const ok = await api.lessonAnswer(space, id, answer, unused);
            if (!ok) return "This question has ended.";
          } catch (e) {
            return `Your answer couldn’t be sent. ${errorText(e)}`;
          } finally {
            unused.close();
          }
          return null;
        }
        let refused: string | null = null;
        await runTurn(async (ch) => {
          const ok = await api.lessonAnswer(space, id, answer, ch);
          if (!ok) refused = "This question has ended.";
        }, "Answer sent. Phaethon is reading it.");
        return refused;
      },
    };
  });
}
