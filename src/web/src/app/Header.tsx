import { BrandMark } from "@/components/brand-mark";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { errorText } from "@/lib/core";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Truncate } from "@/components/truncate";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { keysFor } from "./shortcuts";
import { DRAFT, type OpenTab, useActiveSpace, useNav } from "./store";
import { VIEWS } from "./views";

/**
 * The title bar across the top of the window (docs/UI-REBUILD.md › App
 * frame). There is exactly one, rendered by the shell, so nothing in it moves
 * when the page changes:
 *
 *   ● ● ●  ✳ ▯  [tab] [tab] [tab] ……………… [ Search ⌘K ] [page actions]
 *
 * The mark and the sidebar toggle, then the open tabs (every open page: a
 * conversation, a study page, settings), search, and the page's actions. A
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
  const spaceName = useNav((s) => (tab.kind === "settings" ? undefined : s.spaces.data?.find((x) => x.id === tab.space)?.name));
  const title = useNav((s) => (tab.kind === "chat" && tab.thread !== DRAFT ? s.threads[tab.space]?.data?.find((t) => t.id === tab.thread)?.title : undefined));
  if (tab.kind === "settings") return { icon: icons.settings, label: "Settings" };
  if (tab.kind === "view") return { icon: VIEWS.find((v) => v.id === tab.view)!.icon, label: VIEWS.find((v) => v.id === tab.view)!.label, space: spaceName };
  return { icon: tab.thread === DRAFT ? icons.newChat : icons.chat, label: tab.thread === DRAFT ? "New chat" : (title ?? "Conversation"), space: spaceName };
}

function TabButton({ tab, active }: { tab: OpenTab; active: boolean }) {
  const { icon, label, space } = useTabLabel(tab);
  const activate = useNav((s) => s.activateTab);
  const close = useNav((s) => s.closeTab);
  const keep = useNav((s) => s.keepTab);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <div
      ref={ref}
      role="tab"
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      data-tab={tab.id}
      data-kept={tab.kept || undefined}
      onClick={() => activate(tab.id)}
      onDoubleClick={() => keep(tab.id)}
      onAuxClick={(e) => {
        if (e.button === 1) close(tab.id);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate(tab.id);
        } else if (e.key === "Delete" || e.key === "Backspace") close(tab.id);
      }}
      className={cn(
        "group/tab relative flex h-7 max-w-48 min-w-0 shrink-0 cursor-default select-none items-center gap-1.5 rounded-md pr-1 pl-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "bg-row-selected text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon icon={icon} className="size-3.5 shrink-0" />
      <Truncate tooltip={space && space !== label ? `${label} · ${space}` : label} side="bottom" className={cn("min-w-0 flex-1", !tab.kept && "italic")}>
        {label}
      </Truncate>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`Close ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          close(tab.id);
        }}
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-[opacity,background-color,color] hover:bg-foreground/8 hover:text-foreground",
          active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
        )}
      >
        <Icon icon={icons.close} className="size-3" />
      </button>
    </div>
  );
}

/** Every open page, as a browser-like strip. Ctrl+Tab walks it, ⌘W closes the active one, ⇧⌘T brings the last closed back. */
function TabStrip() {
  const tabs = useNav((s) => s.tabs);
  const active = useNav((s) => s.activeTab);
  const cycle = useNav((s) => s.cycleTab);
  return (
    <div
      role="tablist"
      aria-label="Open pages"
      className="app-no-drag scroll-quiet flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden px-1"
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") cycle(1);
        else if (e.key === "ArrowLeft") cycle(-1);
        else return;
        e.preventDefault();
        requestAnimationFrame(() => (document.querySelector<HTMLElement>('[role="tablist"][aria-label="Open pages"] [aria-selected="true"]'))?.focus());
      }}
    >
      {tabs.map((t) => (
        <TabButton key={t.id} tab={t} active={t.id === active} />
      ))}
    </div>
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
 * The shell's one title bar: the mark and the sidebar toggle, the open tabs,
 * search, and the page's actions. On macOS the traffic lights sit in its left
 * end.
 */
export function AppHeader({ bind }: { bind: { title: (el: HTMLElement | null) => void; actions: (el: HTMLElement | null) => void } }) {
  const space = useActiveSpace();
  const sidebarOpen = useNav((s) => s.sidebarOpen);
  const toggle = useNav((s) => s.toggleSidebar);
  const newChat = useNav((s) => s.newChat);
  return (
    <header
      data-slot="app-header"
      data-sidebar={sidebarOpen ? "open" : "closed"}
      className={cn("group/header @container/header app-drag flex h-(--titlebar-height) shrink-0 items-center gap-2 border-b pr-3", isMac() ? "pl-(--traffic-light-inset)" : "pl-4")}
    >
      <BrandMark className="size-4 shrink-0 text-foreground" label="Phaethon" />
      <div className="mr-1 ml-1 flex shrink-0 items-center">
        <HeaderIconButton label={sidebarOpen ? "Hide sidebar" : "Show sidebar"} keys={keysFor("sidebar").keys} onClick={toggle}>
          <Icon icon={icons.sidebar} />
        </HeaderIconButton>
        {!sidebarOpen && space ? (
          <HeaderIconButton label="New chat" keys={keysFor("newChat").keys} onClick={() => void newChat(space.id).catch((e) => toast.error("Couldn’t start a new chat", errorText(e)))}>
            <Icon icon={icons.newChat} />
          </HeaderIconButton>
        ) : null}
      </div>
      <TabStrip />
      <div ref={bind.title} hidden />
      <SearchField />
      <div ref={bind.actions} data-slot="header-actions" className="app-no-drag flex min-w-0 shrink-0 items-center justify-end gap-1" />
    </header>
  );
}
