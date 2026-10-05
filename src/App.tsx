import { AssistantRuntimeProvider, useLocalRuntime } from "@assistant-ui/react";
import { useState } from "react";

import { SpaceSidebar } from "@/components/space-sidebar";
import { Thread } from "@/components/thread";
import { STUB_SPACES, type Space } from "@/lib/spaces";
import { echoAdapter } from "@/runtime/echo-adapter";

/** One runtime per space: remounted on switch so threads never leak across spaces. */
function SpaceChat({ space }: { space: Space }) {
  const runtime = useLocalRuntime(echoAdapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread spaceName={space.name} />
    </AssistantRuntimeProvider>
  );
}

export default function App() {
  const [activeId, setActiveId] = useState(STUB_SPACES[0].id);
  const active = STUB_SPACES.find((s) => s.id === activeId) ?? STUB_SPACES[0];

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
      >
        Skip to conversation
      </a>
      <SpaceSidebar spaces={STUB_SPACES} activeId={activeId} onSelect={setActiveId} />
      <main id="main" tabIndex={-1} aria-labelledby="space-title" className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-border px-4 py-3">
          <h1 id="space-title" className="text-lg font-semibold">
            {active.name}
          </h1>
        </header>
        <SpaceChat key={active.id} space={active} />
      </main>
    </div>
  );
}
