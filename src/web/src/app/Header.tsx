import { PanelLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { SpaceAvatar } from "@/components/space-avatar";
import { Truncate } from "@/components/truncate";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { keysFor } from "./shortcuts";
import { IconButton } from "./Sidebar";
import { useActiveSpace, useNav } from "./store";
import { VIEWS } from "./views";

/**
 * The 40 px bar over the main area: where you are (space › page), the
 * space's views when it has study tools, and the page's own actions. It is
 * the window's drag region on macOS.
 */
export function Header({ title, actions }: { title?: ReactNode; actions?: ReactNode }) {
  const space = useActiveSpace();
  const sidebarOpen = useNav((s) => s.sidebarOpen);
  const toggle = useNav((s) => s.toggleSidebar);
  const view = useNav((s) => s.view);
  const setView = useNav((s) => s.setView);
  return (
    <header className={cn("@container/header app-drag flex h-(--titlebar-height) shrink-0 items-center gap-2 px-3", !sidebarOpen && isMac() && "pl-[84px]")}>
      {!sidebarOpen ? (
        <IconButton label="Show sidebar" keys={keysFor("sidebar").keys} onClick={toggle}>
          <PanelLeftIcon strokeWidth={1.75} />
        </IconButton>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        {space ? (
          <>
            <SpaceAvatar name={space.name} hue={space.hue} />
            <Truncate className="max-w-40 shrink text-muted-foreground @max-[30rem]/header:hidden">{space.name}</Truncate>
            {title ? <span className="text-subtle-foreground">/</span> : null}
          </>
        ) : null}
        {title ? <div className="min-w-0 flex-1 font-medium">{typeof title === "string" ? <Truncate>{title}</Truncate> : title}</div> : null}
      </div>
      {space?.educationEnabled ? (
        <div className="app-no-drag flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5" role="tablist" aria-label="Views">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              onClick={() => setView(v.id)}
              className={cn(
                "flex h-6 items-center gap-1.5 rounded-md px-2 font-medium text-xs transition-colors",
                view === v.id ? "bg-background text-foreground shadow-xs/5 dark:bg-white/10" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <v.icon className="size-3.5" />
              <span className="@max-[44rem]/header:hidden">{v.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {actions ? <div className="app-no-drag flex shrink-0 items-center gap-1">{actions}</div> : null}
    </header>
  );
}
