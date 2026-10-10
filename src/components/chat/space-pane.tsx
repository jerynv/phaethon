import { AssistantRuntimeProvider, useAuiState, useLocalRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { SetupCard } from "@/components/onboarding/setup-card";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Icon } from "@/icons";
import { setSpaceActivity } from "@/lib/activity";
import { getSettings, SETTINGS_CHANGED_EVENT, type SettingsChangedDetail } from "@/lib/backend";
import type { Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { createAgentAdapter, savedAttachmentId, type AgentMessageCustom } from "@/runtime/agent-adapter";
import { attachmentAdapter } from "@/runtime/attachments";
import { echoAdapter } from "@/runtime/echo-adapter";
import { RECORD_PART, loadUiThread, type RecordPartData, type UiMessage } from "@/runtime/records";
import { ThreadIndex } from "@/runtime/thread-index";

import { ConversationsBar } from "./conversations-bar";
import { focusPaneComposer, paneShown, PaneContext, type Pane } from "./pane";
import { Thread } from "./thread";

/**
 * Tells SpacePane whether a reply is running (the conversations bar refuses a
 * switch then), and tells the shell what this space is doing while you are
 * elsewhere: answering, or waiting for you on a card.
 */
function ActivityProbe({ spaceId, onRunning }: { spaceId: string; onRunning: (running: boolean) => void }) {
  const running = useAuiState((s) => s.thread.isRunning);
  const needsYou = useAuiState((s) => {
    const last = s.thread.messages[s.thread.messages.length - 1];
    if (last?.status?.type !== "running") return false;
    const custom = last.metadata.custom as AgentMessageCustom | undefined;
    return !!(custom?.approval || custom?.accessRequest);
  });
  useEffect(() => onRunning(running), [running, onRunning]);
  useEffect(() => setSpaceActivity(spaceId, { running, needsYou }), [spaceId, running, needsYou]);
  useEffect(
    () => () => {
      onRunning(false);
      setSpaceActivity(spaceId, { running: false, needsYou: false });
    },
    [spaceId, onRunning],
  );
  return null;
}

/**
 * One runtime per space and per conversation: remounted on a conversation
 * switch, so threads never leak into each other. A reply keeps running while
 * another space is shown (the shell keeps this pane mounted, hidden): leaving
 * a space never stops its reply, and coming back shows where it got to.
 */
function SpaceChat({
  space,
  initial,
  onRunning,
  onMounted,
  rootRef,
  setup,
  needsKey,
}: {
  space: Space;
  initial: { messages: readonly ThreadMessageLike[]; index: ThreadIndex };
  onRunning: (running: boolean) => void;
  onMounted: () => void;
  rootRef: RefObject<HTMLElement | null>;
  setup: ReactNode;
  needsKey: boolean;
}) {
  // Inside the desktop app: the agent via the Rust core. In a plain browser
  // (`pnpm dev`) there is no IPC, so fall back to the local echo stub.
  const tauri = inTauri();
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);
  const adapter = useMemo(
    () => (tauri ? createAgentAdapter(space.id, initial.index, () => gone.current) : echoAdapter),
    [space.id, initial.index, tauri],
  );
  const runtime = useLocalRuntime(adapter, {
    initialMessages: initial.messages,
    adapters: { attachments: attachmentAdapter },
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typedAt = useRef(0);
  const pane = useMemo<Pane>(
    () => ({ spaceId: space.id, inputRef, rootRef, typedAt, threadIndex: tauri ? initial.index : null }),
    [space.id, rootRef, tauri, initial.index],
  );
  useEffect(onMounted, [onMounted]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <PaneContext.Provider value={pane}>
        <ActivityProbe spaceId={space.id} onRunning={onRunning} />
        <Thread spaceId={space.id} spaceName={space.name} inputRef={inputRef} setup={setup} needsKey={needsKey} />
      </PaneContext.Provider>
    </AssistantRuntimeProvider>
  );
}

/**
 * A saved message as the thread shows it. Saved attachments are only
 * references to files in the space (no bytes), so they show as name and type,
 * and are never sent again. A reply's records (answers, reads in other
 * spaces, a stop) follow its text as receipts. Each message keeps its saved
 * position, which Edit and Regenerate hand back to the backend.
 */
function toThreadMessage(m: UiMessage, i: number): ThreadMessageLike {
  const id = `saved-${i}`;
  const metadata = { custom: { index: m.index } satisfies AgentMessageCustom };
  if (m.role === "assistant") {
    const records = (m.records ?? []).map((record, j) => ({
      type: "data" as const,
      name: RECORD_PART,
      data: { id: `${id}-rec-${j}`, record } satisfies RecordPartData,
    }));
    return { id, role: "assistant", metadata, content: [...(m.text ? [{ type: "text" as const, text: m.text }] : []), ...records] };
  }
  return {
    id,
    role: "user",
    metadata,
    content: m.text,
    attachments: (m.attachments ?? []).map((a) => ({
      id: savedAttachmentId(a.path),
      type: a.mediaType.startsWith("image/") ? "image" : "document",
      name: a.name,
      contentType: a.mediaType,
      status: { type: "complete" },
      content: [],
    })),
  };
}

type Loaded =
  | { key: string; messages: readonly ThreadMessageLike[]; index: ThreadIndex }
  | { key: string; error: string };

/**
 * The conversations bar, then the space's current conversation once it has
 * loaded. The bar stays mounted across conversation switches (and through a
 * failed load, where New conversation is a way out); the conversation below it
 * is remounted for each one.
 */
export function SpacePane({ space, reloadKey }: { space: Space; reloadKey: number }) {
  // Bumped by "Try again" after a failed load.
  const [attempt, setAttempt] = useState(0);
  // Bumped when New conversation, or opening a saved one, changes the current conversation.
  const [conversation, setConversation] = useState(0);
  const key = `${space.id}:${reloadKey}:${attempt}:${conversation}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [running, setRunning] = useState(false);
  // First run: Phaethon's own agent with no key saved shows the setup card in the empty conversation.
  const [needsKey, setNeedsKey] = useState(false);
  // The card that just saved a key (or switched to Claude Code) stays to show its result until the conversation changes.
  const [cardKept, setCardKept] = useState<string | null>(null);
  // What the last switch did, said once ("New conversation started.").
  const [said, setSaid] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const shown = useCallback(() => paneShown({ rootRef } as Pane), []);
  // After a switch, the composer takes focus once the new conversation is mounted.
  const focusNext = useRef(false);
  const onMounted = useCallback(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    focusPaneComposer({ rootRef, inputRef: { current: rootRef.current?.querySelector("textarea") ?? null } } as Pane);
  }, []);
  const onSwitched = useCallback((message: string) => {
    focusNext.current = true;
    setConversation((n) => n + 1);
    setSaid("");
    requestAnimationFrame(() => setSaid(message));
  }, []);

  useEffect(() => {
    let live = true;
    const done = (l: Loaded) => live && setLoaded(l);
    if (!inTauri()) {
      done({ key, messages: [], index: new ThreadIndex() });
    } else {
      loadUiThread(space.id).then(
        (msgs) => {
          const messages = msgs.map(toThreadMessage);
          const index = new ThreadIndex(msgs.map((m, i) => ({ id: `saved-${i}`, role: m.role, index: m.index })));
          done({ key, messages, index });
        },
        (e: unknown) => done({ key, error: String(e) }),
      );
    }
    return () => {
      live = false;
    };
  }, [key, space.id]);

  useEffect(() => {
    if (!inTauri()) return;
    let live = true;
    const read = () =>
      getSettings().then(
        (s) => live && setNeedsKey(s.backend === "phaethon" && !s.hasAnthropicKey),
        () => {},
      );
    void read();
    // A key saved or a backend chosen anywhere (Settings, or the card in another space) puts the card away.
    const onChanged = (e: Event) => {
      const what = (e as CustomEvent<SettingsChangedDetail>).detail?.what;
      if (what === "key" || what === "backend") void read();
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChanged);
    return () => {
      live = false;
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onChanged);
    };
  }, [reloadKey]);

  let body;
  if (!loaded || loaded.key !== key) {
    body = (
      <p role="status" className="m-auto flex items-center gap-2 text-md text-ink-secondary">
        <Icon name="spinner" className="animate-spin" />
        Loading the conversation in {space.name}…
      </p>
    );
  } else if ("error" in loaded) {
    body = (
      <div className="mx-auto w-full max-w-(--ph-thread-width) px-6 pt-8">
        <div className="flex items-start gap-3 rounded-lg border border-transparent bg-danger-soft px-4 py-3 text-base text-ink">
          <Icon name="error" className="mt-0.5 text-danger-ink" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div role="alert" className="flex flex-col gap-0.5">
              <p className="font-semibold text-danger-ink">The conversation in {space.name} couldn’t be loaded</p>
              <p>
                Its saved file may be damaged or locked by another app. Try again, or check the space’s folder. New
                conversation keeps the file and starts afresh.
              </p>
            </div>
            <div>
              <Button type="button" data-load-retry="" onClick={() => setAttempt((n) => n + 1)}>
                <Icon name="retry" />
                Try again
              </Button>
            </div>
            <Details>
              <p className="font-mono wrap-anywhere text-ink" data-load-error-detail="">
                {loaded.error}
              </p>
            </Details>
          </div>
        </div>
      </div>
    );
  } else {
    body = (
      <SpaceChat
        key={key}
        space={space}
        initial={loaded}
        onRunning={setRunning}
        onMounted={onMounted}
        rootRef={rootRef}
        setup={needsKey || cardKept === key ? <SetupCard space={space} onResult={() => setCardKept(key)} /> : null}
        needsKey={needsKey}
      />
    );
  }

  return (
    <div ref={rootRef} data-space-pane={space.id} className="flex min-h-0 flex-1 flex-col">
      <ConversationsBar space={space} running={running} onSwitched={onSwitched} shown={shown} />
      <p role="status" className="sr-only" data-testid="conversation-status">
        {said}
      </p>
      {body}
    </div>
  );
}
