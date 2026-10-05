import { useState } from "react";

import { SpacePane } from "@/components/chat/space-pane";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { SpaceSidebar } from "@/components/space-sidebar";
import { STUB_SPACES } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";

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
