import { PanelLeftIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { SpaceAvatar } from "@/components/space-avatar";
import { Truncate } from "@/components/truncate";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { keysFor, viewKeys } from "./shortcuts";
import { useActiveSpace, useNav, type View } from "./store";
import { VIEWS } from "./views";

/**
 * The title bar over the main area. There is exactly one, rendered by the
 * shell, so nothing in it moves when the page changes:
 *
 *   [sidebar] space / title ………… [page actions] [Chat Study Grades Plan Courses]
 *
 * The view tabs are pinned to the right edge; a page's actions grow leftwards
 * from them and the title truncates to make room. Pages fill the title and
 * actions by rendering `<Header title actions />` anywhere in their tree: it
 * portals into the bar, and only while that page is the visible one (a page
 * kept alive in the background stays out of the bar). It is the window's drag
 * region on macOS.
 */

type Slots = { title: HTMLElement | null; actions: HTMLElement | null };
const SlotContext = createContext<Slots>({ title: null, actions: null });
const ActiveContext = createContext(true);

/** Marks a subtree as the visible page (or a hidden, kept-alive one). */
export function ViewActive({ active, children }: { active: boolean; children: ReactNode }) {
  return <ActiveContext value={active}>{children}</ActiveContext>;
}

/** False while this page is mounted but hidden (kept alive behind another view). */
export function useViewActive(): boolean {
  return useContext(ActiveContext);
}

/** A page's title and actions, shown in the shell's title bar while the page is visible. */
export function Header({ title, actions }: { title?: ReactNode; actions?: ReactNode }) {
  const slots = useContext(SlotContext);
  const active = useContext(ActiveContext);
  if (!active) return null;
  return (
    <>
      {title && slots.title ? createPortal(typeof title === "string" ? <Truncate className="font-medium">{title}</Truncate> : title, slots.title) : null}
      {actions && slots.actions ? createPortal(actions, slots.actions) : null}
    </>
  );
}

/** Provides the slots the title bar's `Header` portals into. */
export function HeaderSlots({ children }: { children: (bind: { title: (el: HTMLElement | null) => void; actions: (el: HTMLElement | null) => void }) => ReactNode }) {
  const [title, setTitle] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  return <SlotContext value={{ title, actions }}>{children({ title: setTitle, actions: setActions })}</SlotContext>;
}

export function HeaderIconButton({ label, keys, onClick, children }: { label: string; keys?: string[]; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className="app-no-drag inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <span className="flex items-center gap-2">
          {label}
          {keys ? (
            <KbdGroup>
              {keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </KbdGroup>
          ) : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

function ViewTabs() {
  const space = useActiveSpace();
  const view = useNav((s) => s.view);
  const settings = useNav((s) => s.settings);
  const setView = useNav((s) => s.setView);
  if (!space?.educationEnabled) return null;
  return (
    <Tabs value={settings ? null : view} onValueChange={(v) => setView(v as View)} className="app-no-drag shrink-0">
      <TabsList aria-label="Views">
        {VIEWS.map((v, i) => (
          <Tooltip key={v.id}>
            <TooltipTrigger render={<TabsTab value={v.id} aria-label={v.label} />}>
              <v.icon />
              <span className="@max-3xl/header:hidden">{v.label}</span>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <span className="flex items-center gap-2">
                {v.label}
                <KbdGroup>
                  {viewKeys(i).keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </KbdGroup>
              </span>
            </TooltipPopup>
          </Tooltip>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** The shell's one title bar. */
export function AppHeader({ bind }: { bind: { title: (el: HTMLElement | null) => void; actions: (el: HTMLElement | null) => void } }) {
  const space = useActiveSpace();
  const sidebarOpen = useNav((s) => s.sidebarOpen);
  const toggle = useNav((s) => s.toggleSidebar);
  const settings = useNav((s) => s.settings);
  return (
    <header
      data-slot="app-header"
      className={cn("@container/header app-drag flex h-(--titlebar-height) shrink-0 items-center gap-2 px-3", !sidebarOpen && isMac() && "pl-(--traffic-light-inset)")}
    >
      {!sidebarOpen ? (
        <HeaderIconButton label="Show sidebar" keys={keysFor("sidebar").keys} onClick={toggle}>
          <PanelLeftIcon />
        </HeaderIconButton>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        {space && !settings ? (
          <>
            <SpaceAvatar name={space.name} hue={space.hue} />
            <Truncate className="max-w-40 shrink text-muted-foreground @max-md/header:hidden">{space.name}</Truncate>
            <span className="text-subtle-foreground has-[+div:empty]:hidden">/</span>
          </>
        ) : null}
        <div ref={bind.title} data-slot="header-title" className="flex min-w-0 flex-1 items-center gap-1.5 empty:hidden" />
      </div>
      <div ref={bind.actions} data-slot="header-actions" className="app-no-drag flex shrink-0 items-center gap-1 empty:hidden" />
      <ViewTabs />
    </header>
  );
}
