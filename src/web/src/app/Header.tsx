import { BrandWordmark } from "@/components/brand-mark";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { errorText } from "@/lib/core";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { MenuShortcut } from "@/components/ui/menu";
import { PageTab, PageTabList, PageTabNew, pageTabStripClassName } from "@/components/ui/page-tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { isDevChannel, isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { chordText, keysFor } from "./shortcuts";
import { canCloseTab, DRAFT, type OpenTab, useActiveSpace, useNav } from "./store";
import { VIEWS } from "./views";

/**
 * The title bar across the top of the window (docs/UI-REBUILD.md › App
 * frame). There is exactly one, rendered by the shell, so nothing in it moves
 * when the page changes:
 *
 *   ● ● ●  Phaethon        ▯ │ (tab) tab │ tab  + ……………………… [page actions]
 *   └──── the sidebar's column ────┘
 *
 * The left end is exactly the sidebar's column (its width, live while it is
 * dragged, its colour and its hairline): the traffic lights on macOS, the
 * wordmark (the mark alone when the column is narrow) and the sidebar toggle
 * at its right end. The open tabs (every open page: a conversation, a study
 * page, settings) start at the main column's edge, as a browser's tabs, with
 * a + for a new chat after the last, then the page's actions. With the
 * sidebar hidden the column shrinks to the mark, the toggle and Search, and
 * the tabs follow them. A
 * page fills the actions by rendering `<Header actions />` anywhere in its
 * tree: it portals into the bar, and only while that page is the visible one
 * (a page kept alive in the background stays out of the bar). The tab is the
 * page's title. It is the window's drag region on macOS.
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

/** A page's actions, shown at the right of the title bar while the page is visible. (Its tab is its title.) */
export function Header({ actions }: { title?: ReactNode; actions?: ReactNode }) {
  const slots = useContext(SlotContext);
  const active = useContext(ActiveContext);
  if (!active) return null;
  return actions && slots.actions ? createPortal(actions, slots.actions) : null;
}

/**
 * A page action's words beside its icon. In a narrow title bar only the icon
 * stays (the words remain its accessible name), so the open tabs keep their room.
 */
export function ActionLabel({ children }: { children: ReactNode }) {
  return <span className="@max-xl/header:sr-only">{children}</span>;
}

/** A page's title in the title bar, for a page that isn't a tab (Settings): shown in place of the tabs. */
export function HeaderTitle({ children }: { children: ReactNode }) {
  const slots = useContext(SlotContext);
  return slots.title ? createPortal(children, slots.title) : null;
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

/** What a tab shows: its glyph and name. A conversation's name is its title once the list has it. */
function useTabLabel(tab: OpenTab): { icon: (typeof icons)[keyof typeof icons]; label: string; space?: string } {
  const spaceName = useNav((s) => s.spaces.data?.find((x) => x.id === tab.space)?.name);
  const title = useNav((s) => (tab.kind === "chat" && tab.thread !== DRAFT ? s.threads[tab.space]?.data?.find((t) => t.id === tab.thread)?.title : undefined));
  if (tab.kind === "view") return { icon: VIEWS.find((v) => v.id === tab.view)!.icon, label: VIEWS.find((v) => v.id === tab.view)!.label, space: spaceName };
  return { icon: tab.thread === DRAFT ? icons.newChat : icons.chat, label: tab.thread === DRAFT ? "New chat" : (title ?? "Conversation"), space: spaceName };
}

/** A tab's right-click menu: keep it, close it, the others, or the ones after it; bring back the last closed. */
function TabMenuItems({ tab, last, only, closable }: { tab: OpenTab; last: boolean; only: boolean; closable: boolean }) {
  const close = useNav((s) => s.closeTab);
  const keep = useNav((s) => s.keepTab);
  const closeOthers = useNav((s) => s.closeOtherTabs);
  const closeRight = useNav((s) => s.closeTabsToRight);
  const reopen = useNav((s) => s.reopenTab);
  const canReopen = useNav((s) => s.closedTabs.length > 0);
  return (
    <>
      {!tab.kept ? (
        <ContextMenuItem onClick={() => keep(tab.id)}>
          <Icon icon={icons.pin} />
          Keep open
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem disabled={!closable} onClick={() => close(tab.id)}>
        <Icon icon={icons.close} />
        Close
        <MenuShortcut>{chordText(keysFor("closeTab").keys)}</MenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem className="ps-7" disabled={only} onClick={() => closeOthers(tab.id)}>
        Close others
      </ContextMenuItem>
      <ContextMenuItem className="ps-7" disabled={last} onClick={() => closeRight(tab.id)}>
        Close tabs to the right
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={!canReopen} onClick={reopen}>
        <Icon icon={icons.undo} />
        Reopen closed tab
        <MenuShortcut>{chordText(keysFor("reopenTab").keys)}</MenuShortcut>
      </ContextMenuItem>
    </>
  );
}

function TabButton({ tab, active, last, only, closable }: { tab: OpenTab; active: boolean; last: boolean; only: boolean; closable: boolean }) {
  const { icon, label, space } = useTabLabel(tab);
  const activate = useNav((s) => s.activateTab);
  const close = useNav((s) => s.closeTab);
  const keep = useNav((s) => s.keepTab);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <PageTab
      ref={ref}
      active={active}
      data-tab={tab.id}
      data-kept={tab.kept || undefined}
      onClick={() => activate(tab.id)}
      onDoubleClick={() => keep(tab.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate(tab.id);
        } else if (e.key === "Delete" || e.key === "Backspace") close(tab.id);
      }}
      icon={<Icon icon={icon} />}
      label={
        <Truncate tooltip={space && space !== label ? `${label} · ${space}` : label} side="bottom" className={cn("min-w-0 flex-1", !tab.kept && "italic")}>
          {label}
        </Truncate>
      }
      closeLabel={`Close ${label}`}
      // A lone new chat has no ×: closing it would put the same tab back.
      onClose={closable ? () => close(tab.id) : undefined}
      menu={<TabMenuItems tab={tab} last={last} only={only} closable={closable} />}
    />
  );
}

/** Every open page, as a browser's strip. Ctrl+Tab walks it, ⌘W closes the active one, ⇧⌘T brings the last closed back. */
function TabStrip() {
  const tabs = useNav((s) => s.tabs);
  const active = useNav((s) => s.activeTab);
  const cycle = useNav((s) => s.cycleTab);
  return (
    <PageTabList
      aria-label="Open pages"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") cycle(1);
        else if (e.key === "ArrowLeft") cycle(-1);
        else return;
        e.preventDefault();
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[role="tablist"][aria-label="Open pages"] [aria-selected="true"]')?.focus());
      }}
    >
      {tabs.map((t, i) => (
        <TabButton key={t.id} tab={t} active={t.id === active} last={i === tabs.length - 1} only={tabs.length === 1} closable={canCloseTab(tabs, t.id)} />
      ))}
    </PageTabList>
  );
}

/**
 * The shell's one title bar: the mark and the sidebar toggle, the open tabs,
 * and the page's actions. On macOS the traffic lights sit in its left
 * end.
 */
export function AppHeader({ bind }: { bind: { title: (el: HTMLElement | null) => void; actions: (el: HTMLElement | null) => void } }) {
  const space = useActiveSpace();
  // The column is the docked sidebar's; a compact window's floating sidebar leaves the bar as it is when hidden.
  const sidebarOpen = useNav((s) => s.sidebarOpen && !s.compact);
  const peek = useNav((s) => s.peek);
  const toggle = useNav((s) => s.toggleSidebar);
  const newChat = useNav((s) => s.newChat);
  const setPalette = useNav((s) => s.setPalette);
  const settingsOpen = useNav((s) => s.settings !== null);
  const startChat = () => {
    if (space) void newChat(space.id).catch((e) => toast.error("Couldn’t start a new chat", errorText(e)));
  };
  return (
    <header
      data-slot="app-header"
      data-sidebar={sidebarOpen ? "open" : "closed"}
      // Settings has no tabs, so no tab strip either: the bar stays the page's colour with a bottom hairline separating the breadcrumbs from Settings below.
      className={cn(
        "group/header app-drag @container/header relative flex h-(--titlebar-height) shrink-0 items-stretch",
        settingsOpen
          ? "bg-background after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border"
          : pageTabStripClassName,
      )}
    >
      {/*
        The sidebar's column: its width (min-width animates with the sidebar's slide and follows a drag at once),
        its colour and hairline, covering the strip's hairline so the column runs unbroken into the sidebar.
      */}
      <div
        data-slot="titlebar-lead"
        className={cn(
          "relative z-10 flex shrink-0 items-center gap-1 pt-(--titlebar-skew) transition-[min-width,max-width,background-color] duration-200 ease-drawer group-data-[resizing=true]/sidebar-wrapper:transition-none",
          isMac() ? "pl-(--traffic-light-inset)" : "pl-4",
          sidebarOpen ? "@container/lead min-w-(--sidebar-width) max-w-(--sidebar-width) border-r bg-sidebar pr-1.75" : "min-w-0 max-w-none pr-0",
        )}
      >
        <BrandWordmark showName={sidebarOpen} nameClassName="hidden @titlebar-brand/lead:inline" markClassName="@titlebar-brand/lead:relative @titlebar-brand/lead:top-px" />
        {sidebarOpen && isDevChannel() ? (
          <Badge variant="warning" size="sm" className="ml-1.5 hidden @titlebar-brand/lead:inline-flex">
            Dev
          </Badge>
        ) : null}
        {sidebarOpen ? <span className="flex-1" /> : null}
        <HeaderIconButton label={sidebarOpen || peek ? "Hide sidebar" : "Show sidebar"} keys={keysFor("sidebar").keys} onClick={toggle}>
          <Icon icon={icons.sidebar} />
        </HeaderIconButton>
        {/* With the sidebar hidden its search comes along; its New chat is the + after the tabs. */}
        {!sidebarOpen && space ? (
          <HeaderIconButton label="Search" keys={keysFor("search").keys} onClick={() => setPalette(true)}>
            <Icon icon={icons.search} />
          </HeaderIconButton>
        ) : null}
      </div>
      {/* Everything here is centred on the bar's line (--titlebar-line), the line the wordmark and the toggle sit on. */}
      <div className="flex min-w-0 flex-1 items-center">
        {/* Settings isn't a tab: while it's open its breadcrumbs take the tabs' place, aligned with the Settings nav buttons below; Back or Esc returns to the tab you were on. */}
        <div ref={bind.title} hidden={!settingsOpen} className="app-no-drag flex h-full min-w-0 items-center gap-1 pt-(--titlebar-skew) pl-5 text-sm" data-slot="settings-title" />
        {settingsOpen ? null : <TabStrip />}
        {space && !settingsOpen ? (
          <div className="flex h-full shrink-0 items-center pt-(--titlebar-skew)">
            <Tooltip>
              <TooltipTrigger render={<PageTabNew label="New chat" onClick={startChat} className="-ml-1" />} />
              <TooltipPopup side="bottom">
                <span className="flex items-center gap-2">
                  New chat
                  <KbdGroup>
                    {keysFor("newChat").keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </KbdGroup>
                </span>
              </TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        <div className="h-full min-w-4 flex-1" />
        {/*
          A fixed share of the bar for the page's actions, so pages with more or fewer of them never resize the tabs.
          In a narrow bar the share goes, so the tabs keep room for at least one.
        */}
        <div ref={bind.actions} data-slot="header-actions" className="app-no-drag flex h-full shrink-0 items-center justify-end gap-1 pt-(--titlebar-skew) pr-3 @3xl/header:min-w-56" />
      </div>
    </header>
  );
}
