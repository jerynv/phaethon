import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
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
 * The title bar over the main area, inside the app panel (docs/UI-REBUILD.md
 * › App frame). There is exactly one, rendered by the shell, so nothing in it
 * moves when the page changes:
 *
 *   [sidebar] [Chat Study Grades Plan Courses] | title ……[ Search ⌘K ]…… [page actions]
 *
 * Three columns: the view tabs (pill style) and the page's title on the left,
 * search centred on the panel, the page's actions on the right. Pages fill the
 * title and actions by rendering `<Header title actions />` anywhere in their
 * tree: it portals into the bar, and only while that page is the visible one
 * (a page kept alive in the background stays out of the bar). It is the
 * window's drag region on macOS.
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
            className="app-no-drag inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4.5"
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
      <TabsList aria-label="Views" variant="pill">
        {VIEWS.map((v, i) => (
          <Tooltip key={v.id}>
            <TooltipTrigger render={<TabsTab value={v.id} aria-label={v.label} />}>
              <Icon icon={v.icon} />
              <span className="@max-5xl/header:hidden">{v.label}</span>
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

/** Search, as a field centred in the bar; it opens the command palette. */
function SearchField() {
  const setPalette = useNav((s) => s.setPalette);
  const keys = keysFor("search").keys;
  return (
    <button
      type="button"
      aria-label="Search"
      aria-keyshortcuts={keysFor("search").aria}
      onClick={() => setPalette(true)}
      className="app-no-drag flex h-8 w-(--search-width) items-center gap-2 rounded-lg border bg-well pr-1.5 pl-2.5 text-sm text-subtle-foreground outline-none transition-colors hover:border-border-strong hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring @max-3xl/header:w-auto @max-3xl/header:border-transparent @max-3xl/header:bg-transparent"
    >
      <Icon icon={icons.search} className="size-4" />
      <span className="flex-1 text-left @max-3xl/header:hidden">Search</span>
      <KbdGroup className="@max-3xl/header:hidden">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </KbdGroup>
    </button>
  );
}

/** The shell's one title bar. */
export function AppHeader({ bind }: { bind: { title: (el: HTMLElement | null) => void; actions: (el: HTMLElement | null) => void } }) {
  const space = useActiveSpace();
  const sidebarOpen = useNav((s) => s.sidebarOpen);
  const toggle = useNav((s) => s.toggleSidebar);
  const settings = useNav((s) => s.settings);
  const tabs = !!space?.educationEnabled;
  return (
    <header
      data-slot="app-header"
      className={cn(
        "@container/header app-drag grid h-(--titlebar-height) shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b px-3",
        !sidebarOpen && isMac() && "pl-(--traffic-light-inset)",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {!sidebarOpen ? (
          <HeaderIconButton label="Show sidebar" keys={keysFor("sidebar").keys} onClick={toggle}>
            <Icon icon={icons.sidebar} />
          </HeaderIconButton>
        ) : null}
        {space && !settings && !tabs ? (
          <span className="flex min-w-0 shrink items-center gap-1.5 text-sm">
            <SpaceAvatar name={space.name} hue={space.hue} />
            <Truncate className="max-w-40 text-muted-foreground">{space.name}</Truncate>
          </span>
        ) : null}
        <ViewTabs />
        <div
          ref={bind.title}
          data-slot="header-title"
          className="flex min-w-0 flex-1 items-center gap-1.5 border-l pl-3 text-sm text-muted-foreground empty:hidden [&_.font-medium]:text-foreground"
        />
      </div>
      <SearchField />
      <div ref={bind.actions} data-slot="header-actions" className="app-no-drag flex min-w-0 items-center justify-end gap-1" />
    </header>
  );
}
