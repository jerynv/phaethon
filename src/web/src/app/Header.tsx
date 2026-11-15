import { BrandMark } from "@/components/brand-mark";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { errorText } from "@/lib/core";
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
 * The title bar across the top of the app panel (docs/UI-REBUILD.md › App
 * frame). There is exactly one, rendered by the shell, so nothing in it moves
 * when the page changes:
 *
 *   ● ● ●  ✳ ▯  [Chat Study Grades Plan Courses] | title ……[ Search ⌘K ]…… [page actions]
 *
 * Three columns: the mark, sidebar toggle, view tabs (pill style) and the
 * page's title on the left, search centred on the panel, the page's actions
 * on the right. Pages fill the
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
  const view = useNav((s) => s.view);
  const settings = useNav((s) => s.settings !== null);
  if (!active) return null;
  // The tab already names the page: "Grades | Grades" says it twice. (Chat's title is a conversation's.)
  if (!settings && view !== "chat" && typeof title === "string" && title === VIEWS.find((v) => v.id === view)?.label) title = undefined;
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
            className="app-no-drag inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4.5"
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

/** The view tabs. Their labels give way to icons when the bar is too short for them and a page title; never per page, so the tabs never move. */
function ViewTabs() {
  const space = useActiveSpace();
  const view = useNav((s) => s.view);
  const settings = useNav((s) => s.settings);
  const setView = useNav((s) => s.setView);
  const retap = useNav((s) => s.retapView);
  if (!space?.educationEnabled) return null;
  return (
    <Tabs value={settings ? null : view} onValueChange={(v) => setView(v as View)} className="app-no-drag shrink-0">
      <TabsList aria-label="Views" size="sm">
        {VIEWS.map((v, i) => (
          <Tooltip key={v.id}>
            <TooltipTrigger render={<TabsTab value={v.id} aria-label={v.label} onClick={() => !settings && v.id === view && retap(v.id)} className="h-6 gap-1.5 px-2 font-normal [&_svg]:size-3.5" />}>
              <Icon icon={v.icon} />
              {/* Narrow bars show icons only; so do the other tabs while a page shows a back crumb, so the crumb always fits. */}
              <span className="@max-header-labels/lead:hidden group-has-[[data-slot=crumbs]]/header:[[role=tab][aria-selected=false]_&]:hidden">{v.label}</span>
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

/**
 * Search, as a quiet field centred on the panel (the references' "Search ⌘K");
 * it opens the command palette. The keys are plain text, not keycaps.
 */
function SearchField() {
  const setPalette = useNav((s) => s.setPalette);
  const open = useNav((s) => s.paletteOpen);
  const { keys, aria } = keysFor("search");
  return (
    <button
      type="button"
      aria-label="Search"
      aria-keyshortcuts={aria}
      aria-expanded={open}
      onClick={() => setPalette(true)}
      className="app-no-drag group/search flex h-6.5 w-(--search-width) items-center gap-2 rounded-md border bg-background pr-2 pl-2.5 text-sm text-subtle-foreground outline-none transition-colors hover:border-border-strong hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:border-border-strong @max-5xl/header:w-auto @max-5xl/header:border-transparent @max-5xl/header:px-1.5"
    >
      <Icon icon={icons.search} className="size-4" />
      <span className="flex-1 text-left @max-5xl/header:hidden">Search</span>
      <span aria-hidden className="flex items-center gap-0.5 text-xs tabular-nums @max-5xl/header:hidden">
        {keys.map((k) => (
          <span key={k}>{k}</span>
        ))}
      </span>
    </button>
  );
}

/**
 * The shell's one title bar, across the whole panel (references a163, 9334,
 * 3940): the mark and the sidebar toggle, the view tabs and the page's title
 * on the left, search centred over the page, the page's actions on the right.
 * On macOS the traffic lights sit in its left end.
 */
export function AppHeader({ bind }: { bind: { title: (el: HTMLElement | null) => void; actions: (el: HTMLElement | null) => void } }) {
  const space = useActiveSpace();
  const sidebarOpen = useNav((s) => s.sidebarOpen);
  const toggle = useNav((s) => s.toggleSidebar);
  const settings = useNav((s) => s.settings);
  const newChat = useNav((s) => s.newChat);
  const tabs = !!space?.educationEnabled;
  return (
    <header
      data-slot="app-header"
      data-sidebar={sidebarOpen ? "open" : "closed"}
      className={cn(
        "group/header @container/header app-drag grid h-(--titlebar-height) shrink-0 items-center border-b transition-[grid-template-columns] duration-200 ease-drawer group-data-[resizing=true]/sidebar-wrapper:transition-none",
        // The first track is the sidebar's width, so search centres over the page below it.
        "grid-cols-[var(--sidebar-width)_minmax(0,1fr)_auto_minmax(0,1fr)] data-[sidebar=closed]:grid-cols-[0_minmax(0,1fr)_auto_minmax(0,1fr)]",
      )}
    >
      <div className={cn("@container/lead col-span-2 flex min-w-0 items-center gap-1 pr-3", isMac() ? "pl-(--traffic-light-inset)" : "pl-4")}>
        <BrandMark className="size-4 text-foreground" label="Phaethon" />
        <div className="mr-1 ml-2 flex items-center">
          <HeaderIconButton label={sidebarOpen ? "Hide sidebar" : "Show sidebar"} keys={keysFor("sidebar").keys} onClick={toggle}>
            <Icon icon={icons.sidebar} />
          </HeaderIconButton>
          {!sidebarOpen && space ? (
            <HeaderIconButton label="New chat" keys={keysFor("newChat").keys} onClick={() => void newChat(space.id).catch((e) => toast.error("Couldn’t start a new chat", errorText(e)))}>
              <Icon icon={icons.newChat} />
            </HeaderIconButton>
          ) : null}
        </div>
        {space && !settings && !tabs ? (
          <span className="flex min-w-0 shrink items-center gap-2 px-1 text-sm">
            <SpaceAvatar name={space.name} hue={space.hue} />
            <Truncate className="max-w-40 text-foreground">{space.name}</Truncate>
          </span>
        ) : null}
        <ViewTabs />
        <div className="@container/title mr-4 ml-2 flex min-w-0 flex-1">
          <div
            ref={bind.title}
            data-slot="header-title"
            className="flex min-w-0 flex-1 items-center gap-1.5 border-l pl-3 text-sm text-muted-foreground empty:hidden @max-header-title/title:hidden [&_.font-medium]:text-foreground"
          />
        </div>
      </div>
      <SearchField />
      <div ref={bind.actions} data-slot="header-actions" className="app-no-drag flex min-w-0 items-center justify-end gap-1 pr-3 pl-3" />
    </header>
  );
}
