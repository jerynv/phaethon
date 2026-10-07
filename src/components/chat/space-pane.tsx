import { AssistantRuntimeProvider, useAuiState, useLocalRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Icon } from "@/icons";
import { loadThread, type SavedMessage } from "@/lib/backend";
import type { Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cancelSpaceRun, createAgentAdapter } from "@/runtime/agent-adapter";
import { attachmentAdapter } from "@/runtime/attachments";
import { echoAdapter } from "@/runtime/echo-adapter";

import { focusComposer } from "./approval-card";
import { ConversationsBar } from "./conversations-bar";
import { Thread } from "./thread";

/** Tells SpacePane whether a reply is running, so the conversations bar can refuse a switch. */
function RunningProbe({ onRunning }: { onRunning: (running: boolean) => void }) {
  const running = useAuiState((s) => s.thread.isRunning);
  useEffect(() => onRunning(running), [running, onRunning]);
  useEffect(() => () => onRunning(false), [onRunning]);
  return null;
}

/**
 * One runtime per space and per conversation: remounted on a space or
 * conversation switch, so threads never leak into each other.
 */
function SpaceChat({
  space,
  initial,
  onRunning,
  onMounted,
}: {
  space: Space;
  initial: readonly ThreadMessageLike[];
  onRunning: (running: boolean) => void;
  onMounted: () => void;
}) {
  // Inside the desktop app: the agent via the Rust core. In a plain browser
  // (`pnpm dev`) there is no IPC, so fall back to the local echo stub.
  const adapter = useMemo(() => (inTauri() ? createAgentAdapter(space.id) : echoAdapter), [space.id]);
  const runtime = useLocalRuntime(adapter, {
    initialMessages: initial,
    adapters: { attachments: attachmentAdapter },
  });
  // Leaving a space stops any reply still running there rather than letting it
  // finish where nobody can see it. (The saved thread keeps what was done.)
  useEffect(() => () => cancelSpaceRun(space.id), [space.id]);
  useEffect(onMounted, [onMounted]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <RunningProbe onRunning={onRunning} />
      <Thread spaceId={space.id} spaceName={space.name} />
    </AssistantRuntimeProvider>
  );
}

/**
 * A saved message as the thread shows it. Saved attachments are only
 * references to files in the space (no bytes), so they show as name and type,
 * and are never sent again.
 */
function toThreadMessage(m: SavedMessage, index: number): ThreadMessageLike {
  if (m.role !== "user" || !m.attachments?.length) return { role: m.role, content: m.text };
  return {
    role: "user",
    content: m.text,
    attachments: m.attachments.map((a, i) => ({
      id: `saved-${index}-${i}`,
      type: a.mediaType.startsWith("image/") ? "image" : "document",
      name: a.name,
      contentType: a.mediaType,
      status: { type: "complete" },
      content: [],
    })),
  };
}

type Loaded = { key: string; messages: readonly ThreadMessageLike[] } | { key: string; error: string };

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
  // What the last switch did, said once ("New conversation started.").
  const [said, setSaid] = useState("");
  // After a switch, the composer takes focus once the new conversation is mounted.
  const focusNext = useRef(false);
  const onMounted = useCallback(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    focusComposer();
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
      done({ key, messages: [] });
    } else {
      loadThread(space.id).then(
        (msgs) => done({ key, messages: msgs.map(toThreadMessage) }),
        (e: unknown) => done({ key, error: String(e) }),
      );
    }
    return () => {
      live = false;
    };
  }, [key, space.id]);

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
      <SpaceChat key={key} space={space} initial={loaded.messages} onRunning={setRunning} onMounted={onMounted} />
    );
  }

  return (
    <>
      <ConversationsBar space={space} running={running} onSwitched={onSwitched} />
      <p role="status" className="sr-only" data-testid="conversation-status">
        {said}
      </p>
      {body}
    </>
  );
}
