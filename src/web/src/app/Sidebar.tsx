import { ChevronRightIcon, EllipsisIcon, FolderOpenIcon, PanelLeftIcon, PlusIcon, SearchIcon, Settings2Icon, SquarePenIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { SpaceAvatar } from "@/components/space-avatar";
import { RowError } from "@/components/errors";
import { SkeletonRows } from "@/components/skeletons";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useChats } from "@/features/chat/store";
import { errorText } from "@/lib/core";
import { compactTime, isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { api, type SpaceView, type ThreadSummary } from "./api";
import { keysFor } from "./shortcuts";
import { NewSpaceDialog } from "./NewSpaceDialog";
import { UpdatePill } from "./UpdatePill";
import { useNav } from "./store";

/**
 * The left panel, after T3 Code's: spaces are groups (like its projects) with
 * their conversations under them, 28 px rows on a tinted panel, actions on
 * hover, compact relative times in the trailing slot.
 */

const SHOWN = 8;

export function IconButton({ label, keys, onClick, children, className }: { label: string; keys?: string[]; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={cn("app-no-drag inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4", className)}
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

export function SidebarTopBar() {
  const toggle = useNav((s) => s.toggleSidebar);
  const space = useNav((s) => s.activeSpace);
  const newChat = useNav((s) => s.newChat);
  return (
    <div className={cn("app-drag flex h-(--titlebar-height) shrink-0 items-center gap-1 pr-2", isMac() ? "pl-[76px]" : "pl-3")}>
      {!isMac() ? <span className="font-semibold text-sm tracking-[-0.01em]">Phaethon</span> : null}
      <div className="ml-auto flex items-center gap-0.5">
        <IconButton label="Hide sidebar" keys={keysFor("sidebar").keys} onClick={toggle}>
          <PanelLeftIcon strokeWidth={1.75} />
        </IconButton>
        <IconButton
          label="New chat"
          keys={keysFor("newChat").keys}
          onClick={() => space && void newChat(space).catch((e) => toast.error("Couldn’t start a new chat", errorText(e)))}
        >
          <SquarePenIcon strokeWidth={1.75} />
        </IconButton>
      </div>
    </div>
  );
}

function SearchButton() {
  const setPalette = useNav((s) => s.setPalette);
  return (
    <button
      type="button"
      onClick={() => setPalette(true)}
      className="mx-2 flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
    >
      <SearchIcon className="size-3.5" strokeWidth={2} />
      <span>Search</span>
      <KbdGroup className="ml-auto">
        {keysFor("search").keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </KbdGroup>
    </button>
  );
}

function ThreadRow({ space, thread, active }: { space: string; thread: ThreadSummary; active: boolean }) {
  const openThread = useNav((s) => s.openThread);
  const deleteThread = useNav((s) => s.deleteThread);
  const running = useChats((s) => (thread.current ? (s.bySpace[space]?.running ?? false) : false));
  const [menu, setMenu] = useState(false);
  const open = () => void openThread(space, thread.id).catch((e) => toast.error("Couldn’t open that conversation", errorText(e)));
  const remove = () =>
    void deleteThread(space, thread.id).then(
      () => toast.success("Conversation deleted"),
      (e) => toast.error("Couldn’t delete the conversation", errorText(e)),
    );
  return (
    <div
      className={cn(
        "group/row relative flex h-7 items-center rounded-md pr-1 pl-7 text-sm transition-colors",
        active ? "bg-row-selected text-foreground" : "text-sidebar-foreground/85 hover:bg-accent hover:text-foreground",
      )}
      data-active={active || undefined}
    >
      <button type="button" className="absolute inset-0 rounded-md" aria-label={thread.title} aria-current={active ? "page" : undefined} onClick={open} />
      <Truncate className="pointer-events-none relative flex-1 pr-1" side="right">
        {thread.title}
      </Truncate>
      <span className={cn("relative flex w-8 shrink-0 justify-end", menu && "hidden")}>
        {running ? (
          <span className="mr-1 size-1.5 animate-status-pulse rounded-full bg-primary" aria-label="Answering" />
        ) : (
          <span className="text-2xs text-subtle-foreground tabular-nums group-hover/row:hidden">{thread.messages ? compactTime(thread.updated) : ""}</span>
        )}
      </span>
      <Menu open={menu} onOpenChange={setMenu}>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label="Conversation actions"
              className={cn(
                "relative inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground",
                menu ? "flex" : "hidden group-hover/row:flex",
              )}
            />
          }
        >
          <EllipsisIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="start" side="right">
          <MenuItem onClick={open}>Open</MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={remove}>
            <Trash2Icon />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

function SpaceGroup({ space, index }: { space: SpaceView; index: number }) {
  const active = useNav((s) => s.activeSpace === space.id);
  const view = useNav((s) => s.view);
  const settingsOpen = useNav((s) => s.settings !== null);
  const threads = useNav((s) => s.threads[space.id]);
  const collapsed = useNav((s) => !!s.collapsed[space.id]);
  const toggleCollapsed = useNav((s) => s.toggleCollapsed);
  const selectSpace = useNav((s) => s.selectSpace);
  const newChat = useNav((s) => s.newChat);
  const loadThreads = useNav((s) => s.loadThreads);
  const openSettings = useNav((s) => s.openSettings);
  const [all, setAll] = useState(false);
  const list = (threads?.data ?? []).filter((t) => !(t.current && t.messages === 0));
  const shown = all ? list : list.slice(0, SHOWN);
  return (
    <div className="flex flex-col gap-px">
      <div className="group/space relative flex h-7 items-center gap-1.5 rounded-md pr-1 pl-1.5 text-sm hover:bg-accent">
        <button type="button" aria-expanded={!collapsed} aria-label={`${collapsed ? "Expand" : "Collapse"} ${space.name}`} onClick={() => toggleCollapsed(space.id)} className="relative z-10 inline-flex size-4 items-center justify-center text-subtle-foreground">
          <ChevronRightIcon className={cn("size-3 transition-transform duration-150", !collapsed && "rotate-90")} strokeWidth={2.25} />
        </button>
        <button type="button" className="absolute inset-0 rounded-md" aria-label={`Go to ${space.name}`} onClick={() => selectSpace(space.id)} />
        <SpaceAvatar name={space.name} hue={space.hue} className="pointer-events-none relative" />
        <Truncate className={cn("pointer-events-none relative flex-1 font-medium", active && !settingsOpen ? "text-foreground" : "text-sidebar-foreground/90")}>{space.name}</Truncate>
        {index < 9 ? <span className="relative text-3xs text-subtle-foreground tabular-nums group-hover/space:hidden">{isMac() ? `⌘${index + 1}` : ""}</span> : null}
        <span className="relative hidden items-center group-hover/space:flex">
          <Menu>
            <MenuTrigger render={<button type="button" aria-label={`${space.name} actions`} className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" />}>
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="start" side="right">
              <MenuItem onClick={() => void api.showSpace(space.id).catch((e) => toast.error("Couldn’t show the folder", errorText(e)))}>
                <FolderOpenIcon />
                Show folder
              </MenuItem>
              <MenuItem onClick={() => openSettings("spaces")}>
                <Settings2Icon />
                Space settings
              </MenuItem>
            </MenuPopup>
          </Menu>
          <button
            type="button"
            aria-label={`New chat in ${space.name}`}
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => void newChat(space.id).catch((e) => toast.error("Couldn’t start a new chat", errorText(e)))}
          >
            <SquarePenIcon className="size-3.5" strokeWidth={1.75} />
          </button>
        </span>
      </div>
      {collapsed ? null : threads?.loading && !threads.data ? (
        <SkeletonRows count={3} className="pl-5" />
      ) : threads?.error && !threads.data ? (
        <RowError className="h-7 pl-7" message="Couldn’t load conversations" onRetry={() => void loadThreads(space.id)} />
      ) : list.length === 0 ? (
        <div className="flex h-7 items-center pl-7 text-subtle-foreground text-xs">No conversations yet</div>
      ) : (
        <>
          {shown.map((t) => (
            <ThreadRow key={t.id} space={space.id} thread={t} active={active && !settingsOpen && view === "chat" && t.current} />
          ))}
          {list.length > SHOWN ? (
            <button type="button" onClick={() => setAll((v) => !v)} className="flex h-6 items-center pl-7 text-left text-muted-foreground text-xs hover:text-foreground">
              {all ? "Show fewer" : `Show ${list.length - SHOWN} more`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

export function Sidebar() {
  const spaces = useNav((s) => s.spaces);
  const loadSpaces = useNav((s) => s.loadSpaces);
  const openSettings = useNav((s) => s.openSettings);
  const [creating, setCreating] = useState(false);
  return (
    <nav aria-label="Spaces and conversations" className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      <SidebarTopBar />
      <SearchButton />
      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
        <div className="group/label flex h-6 items-center justify-between pr-1 pl-2">
          <span className="font-medium text-2xs text-muted-foreground">Spaces</span>
          <button type="button" aria-label="New space" onClick={() => setCreating(true)} className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/label:opacity-100 focus-visible:opacity-100">
            <PlusIcon className="size-3.5" strokeWidth={2} />
          </button>
        </div>
        {spaces.loading && !spaces.data ? (
          <SkeletonRows count={5} withIcon />
        ) : spaces.error && !spaces.data ? (
          <RowError className="h-7 px-2" message="Couldn’t load your spaces" onRetry={() => void loadSpaces()} />
        ) : (
          <div className="flex flex-col gap-2">
            {(spaces.data ?? []).map((s, i) => (
              <SpaceGroup key={s.id} space={s} index={i} />
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-1 border-t px-2 py-2">
        <UpdatePill />
        <button type="button" onClick={() => openSettings()} className="flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground">
          <Settings2Icon className="size-4" strokeWidth={1.75} />
          Settings
          <KbdGroup className="ml-auto">
            {keysFor("settings").keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </KbdGroup>
        </button>
      </div>
      <NewSpaceDialog open={creating} onOpenChange={setCreating} />
    </nav>
  );
}
