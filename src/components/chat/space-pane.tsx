import { AssistantRuntimeProvider, useLocalRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { loadThread, type SavedMessage } from "@/lib/backend";
import type { Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cancelSpaceRun, createAgentAdapter } from "@/runtime/agent-adapter";
import { attachmentAdapter } from "@/runtime/attachments";
import { echoAdapter } from "@/runtime/echo-adapter";

import { Thread } from "./thread";

/** One runtime per space: remounted on switch so threads never leak across spaces. */
function SpaceChat({ space, initial }: { space: Space; initial: readonly ThreadMessageLike[] }) {
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
  return (
    <AssistantRuntimeProvider runtime={runtime}>
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

/** Load the space's saved conversation, then show it. */
export function SpacePane({ space, reloadKey }: { space: Space; reloadKey: number }) {
  // Bumped by "Try again" after a failed load.
  const [attempt, setAttempt] = useState(0);
  const key = `${space.id}:${reloadKey}:${attempt}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

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

  if (!loaded || loaded.key !== key) {
    return (
      <p role="status" className="m-auto flex items-center gap-2 text-md text-ink-secondary">
        <Icon name="spinner" className="animate-spin" />
        Loading the conversation in {space.name}…
      </p>
    );
  }
  if ("error" in loaded) {
    return (
      <div className="mx-auto w-full max-w-(--ph-thread-width) px-6 pt-8">
        <div className="flex items-start gap-3 rounded-lg border border-transparent bg-danger-soft px-4 py-3 text-base text-ink">
          <Icon name="error" className="mt-0.5 text-danger-ink" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div role="alert" className="flex flex-col gap-0.5">
              <p className="font-semibold text-danger-ink">The conversation in {space.name} couldn’t be loaded</p>
              <p>Its saved file may be damaged or locked by another app. Try again, or check the space’s folder.</p>
            </div>
            <div>
              <Button type="button" data-load-retry="" onClick={() => setAttempt((n) => n + 1)}>
                <Icon name="retry" />
                Try again
              </Button>
            </div>
            <details className="text-sm text-ink-secondary">
              <summary className="inline-flex min-h-(--ph-control-height-sm) cursor-default items-center rounded-sm select-none hover:text-ink">
                Details
              </summary>
              <p className="font-mono wrap-anywhere text-ink">{loaded.error}</p>
            </details>
          </div>
        </div>
      </div>
    );
  }
  return <SpaceChat key={key} space={space} initial={loaded.messages} />;
}
