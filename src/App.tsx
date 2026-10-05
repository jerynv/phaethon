import { AssistantRuntimeProvider, useLocalRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { useEffect, useMemo, useState } from "react";

import { SettingsDialog } from "@/components/settings-dialog";
import { SpaceSidebar } from "@/components/space-sidebar";
import { Thread } from "@/components/thread";
import { loadThread } from "@/lib/backend";
import { STUB_SPACES, type Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cancelSpaceRun, createAgentAdapter } from "@/runtime/agent-adapter";
import { echoAdapter } from "@/runtime/echo-adapter";

/** One runtime per space: remounted on switch so threads never leak across spaces. */
function SpaceChat({ space, initial }: { space: Space; initial: readonly ThreadMessageLike[] }) {
  // Inside the desktop app: the agent via the Rust core. In a plain browser
  // (`pnpm dev`) there is no IPC, so fall back to the local echo stub.
  const adapter = useMemo(() => (inTauri() ? createAgentAdapter(space.id) : echoAdapter), [space.id]);
  const runtime = useLocalRuntime(adapter, { initialMessages: initial });
  // Leaving a space stops any reply still running there rather than letting it
  // finish where nobody can see it. (The saved thread keeps what was done.)
  useEffect(() => () => cancelSpaceRun(space.id), [space.id]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread spaceId={space.id} spaceName={space.name} />
    </AssistantRuntimeProvider>
  );
}

type Loaded = { key: string; messages: readonly ThreadMessageLike[] } | { key: string; error: string };

/** Load the space's saved conversation, then show it. */
function SpacePane({ space, reloadKey }: { space: Space; reloadKey: number }) {
  const key = `${space.id}:${reloadKey}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let live = true;
    const done = (l: Loaded) => live && setLoaded(l);
    if (!inTauri()) {
      done({ key, messages: [] });
    } else {
      loadThread(space.id).then(
        (msgs) => done({ key, messages: msgs.map((m) => ({ role: m.role, content: m.text })) }),
        (e: unknown) => done({ key, error: String(e) }),
      );
    }
    return () => {
      live = false;
    };
  }, [key, space.id]);

  if (!loaded || loaded.key !== key) {
    return (
      <p role="status" className="m-auto text-muted-foreground">
        Loading the conversation in {space.name}…
      </p>
    );
  }
  if ("error" in loaded) {
    return (
      <p role="alert" className="m-4 rounded-md border-2 border-destructive px-3 py-2">
        <strong>Error: </strong>
        {loaded.error}
      </p>
    );
  }
  return <SpaceChat key={key} space={space} initial={loaded.messages} />;
}

export default function App() {
  const [activeId, setActiveId] = useState(STUB_SPACES[0].id);
  // Bumped when settings change (e.g. the backend), so the thread reloads.
  const [reloadKey, setReloadKey] = useState(0);
  const active = STUB_SPACES.find((s) => s.id === activeId) ?? STUB_SPACES[0];

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
      >
        Skip to conversation
      </a>
      <SpaceSidebar
        spaces={STUB_SPACES}
        activeId={activeId}
        onSelect={setActiveId}
        footer={inTauri() ? <SettingsDialog onChanged={() => setReloadKey((k) => k + 1)} /> : null}
      />
      <main id="main" tabIndex={-1} aria-labelledby="space-title" className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-border px-4 py-3">
          <h1 id="space-title" className="text-lg font-semibold">
            {active.name}
          </h1>
        </header>
        <SpacePane space={active} reloadKey={reloadKey} />
      </main>
    </div>
  );
}
