import { PushPinSimple } from "@phosphor-icons/react";
import {
  ChevronRightIcon,
  EllipsisIcon,
  FolderOpenIcon,
  PanelLeftIcon,
  PencilLineIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  Settings2Icon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SpaceAvatar } from "@/components/space-avatar";
import { cleanMessage, FieldError, RowError } from "@/components/errors";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import {
  Sidebar as Panel,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuTrail,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
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
 * The left panel, after T3 Code's: spaces are groups with their
 * conversations under them, 28 px rows, a status gutter on the left (working,
 * unread, pinned), the time on the right that gives way to actions on hover.
 * Conversations can be renamed in place, pinned to the top of their space and
 * deleted after a confirm. Built on components/ui/sidebar.
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
          {keys ? <Keys keys={keys} /> : null}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

function Keys({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <KbdGroup className={className}>
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </KbdGroup>
  );
}

function TopBar() {
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
        <IconButton label="New chat" keys={keysFor("newChat").keys} onClick={() => space && void newChat(space).catch((e) => toast.error("Couldn’t start a new chat", errorText(e)))}>
          <SquarePenIcon strokeWidth={1.75} />
        </IconButton>
      </div>
    </div>
  );
}

function SearchRow() {
  const setPalette = useNav((s) => s.setPalette);
  return (
    <div className="px-2">
      <SidebarMenuButton tone="muted" onClick={() => setPalette(true)}>
        <SearchIcon className="size-3.5" strokeWidth={2} />
        <span className="flex-1">Search</span>
        <Keys keys={keysFor("search").keys} />
      </SidebarMenuButton>
    </div>
  );
}

/** Pinned first (in the order they were pinned), then the rest as the core lists them; the empty new one is hidden. */
export function orderThreads(list: ThreadSummary[]): { pinned: ThreadSummary[]; rest: ThreadSummary[] } {
  const shown = list.filter((t) => !(t.current && t.messages === 0));
  return {
    pinned: shown.filter((t) => t.pinned).sort((a, b) => a.pinned! - b.pinned!),
    rest: shown.filter((t) => !t.pinned),
  };
}

/** The title as an input: Enter or leaving saves, Escape cancels, empty goes back to the automatic title. */
function RenameField({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(value);
  };
  return (
    <input
      ref={ref}
      aria-label="Conversation title"
      defaultValue={initial}
      maxLength={120}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      className="h-7 w-full min-w-0 rounded-md bg-background pr-2 pl-7 text-sm outline-none ring-1 ring-ring"
    />
  );
}

function StatusMark({ running, unread, pinned }: { running: boolean; unread: boolean; pinned: boolean }) {
  if (running) return <span className="size-1.5 animate-status-pulse rounded-full bg-primary" aria-label="Answering" />;
  if (unread) return <span className="size-1.5 rounded-full bg-primary" aria-label="New reply" />;
  if (pinned) return <PushPinSimple className="size-3 text-subtle-foreground" weight="fill" aria-label="Pinned" />;
  return null;
}

function ThreadRow({ space, thread, active, onDelete }: { space: string; thread: ThreadSummary; active: boolean; onDelete: (t: ThreadSummary) => void }) {
  const openThread = useNav((s) => s.openThread);
  const renameThread = useNav((s) => s.renameThread);
  const pinThread = useNav((s) => s.pinThread);
  const running = useChats((s) => (thread.current ? (s.bySpace[space]?.running ?? false) : false));
  const unread = useNav((s) => thread.current && !!s.unread[space]);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const open = () => void openThread(space, thread.id).catch((e) => toast.error("Couldn’t open that conversation", errorText(e)));
  const rename = (title: string | null) => {
    setRenaming(false);
    if (title === null || title.trim() === thread.title) return;
    void renameThread(space, thread.id, title).catch((e) => toast.error("Couldn’t rename the conversation", errorText(e)));
  };
  const pin = (on: boolean) => void pinThread(space, thread.id, on).catch((e) => toast.error(on ? "Couldn’t pin the conversation" : "Couldn’t unpin the conversation", errorText(e)));

  return (
    <SidebarMenuItem data-keep={menu || undefined}>
      {renaming ? (
        <RenameField initial={thread.title} onDone={rename} />
      ) : (
        <>
          <SidebarMenuButton
            isActive={active}
            aria-current={active ? "page" : undefined}
            aria-label={thread.title}
            onClick={open}
            className="pl-7"
          >
            <Truncate side="right" className="flex-1">
              {thread.title}
            </Truncate>
            {thread.messages ? <SidebarMenuBadge>{compactTime(thread.updated)}</SidebarMenuBadge> : null}
          </SidebarMenuButton>
          <span className="pointer-events-none absolute inset-y-0 left-2.5 flex w-3 items-center justify-center">
            <StatusMark running={running} unread={unread} pinned={!!thread.pinned} />
          </span>
          <SidebarMenuTrail keep={menu}>
            <Menu open={menu} onOpenChange={setMenu}>
              <MenuTrigger render={<SidebarMenuAction aria-label="Conversation actions" />}>
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="start" side="right">
                <MenuItem onClick={() => setRenaming(true)}>
                  <PencilLineIcon />
                  Rename
                </MenuItem>
                {thread.renamed ? (
                  <MenuItem onClick={() => rename("")}>
                    <RotateCcwIcon />
                    Reset title
                  </MenuItem>
                ) : null}
                <MenuItem onClick={() => pin(!thread.pinned)}>
                  {thread.pinned ? <PinOffIcon /> : <PinIcon />}
                  {thread.pinned ? "Unpin" : "Pin to top"}
                </MenuItem>
                <MenuSeparator />
                <MenuItem variant="destructive" disabled={running} onClick={() => onDelete(thread)}>
                  <Trash2Icon />
                  Delete…
                </MenuItem>
              </MenuPopup>
            </Menu>
          </SidebarMenuTrail>
        </>
      )}
    </SidebarMenuItem>
  );
}

function SpaceGroup({ space, index, onDelete }: { space: SpaceView; index: number; onDelete: (space: string, t: ThreadSummary) => void }) {
  const active = useNav((s) => s.activeSpace === space.id);
  const view = useNav((s) => s.view);
  const settingsOpen = useNav((s) => s.settings !== null);
  const threads = useNav((s) => s.threads[space.id]);
  const collapsed = useNav((s) => !!s.collapsed[space.id]);
  const unread = useNav((s) => !!s.unread[space.id]);
  const toggleCollapsed = useNav((s) => s.toggleCollapsed);
  const selectSpace = useNav((s) => s.selectSpace);
  const newChat = useNav((s) => s.newChat);
  const loadThreads = useNav((s) => s.loadThreads);
  const openSettings = useNav((s) => s.openSettings);
  const [all, setAll] = useState(false);
  const [menu, setMenu] = useState(false);
  const { pinned, rest } = orderThreads(threads?.data ?? []);
  const count = pinned.length + rest.length;
  const shown = all ? rest : rest.slice(0, SHOWN);
  const chatOn = active && !settingsOpen && view === "chat";

  return (
    <li className="flex flex-col">
      <div className="group/menu-item relative" data-keep={menu || undefined}>
        <SidebarMenuButton aria-label={`Go to ${space.name}`} onClick={() => selectSpace(space.id)} className="pl-6 group-hover/menu-item:pr-12 group-has-focus-visible/menu-item:pr-12 group-data-[keep=true]/menu-item:pr-12">
          <SpaceAvatar name={space.name} hue={space.hue} />
          <Truncate className={cn("flex-1 font-medium", active && !settingsOpen ? "text-foreground" : "text-sidebar-foreground/90")}>{space.name}</Truncate>
          {collapsed && unread ? <span className="size-1.5 shrink-0 rounded-full bg-primary group-hover/menu-item:hidden group-has-focus-visible/menu-item:hidden group-data-[keep=true]/menu-item:hidden" aria-label="New reply" /> : null}
          {collapsed && count ? (
            <SidebarMenuBadge className="group-hover/menu-item:hidden group-has-focus-visible/menu-item:hidden group-data-[keep=true]/menu-item:hidden">{count}</SidebarMenuBadge>
          ) : !collapsed && index < 9 && isMac() ? (
            <SidebarMenuBadge className="text-3xs group-hover/menu-item:hidden group-has-focus-visible/menu-item:hidden group-data-[keep=true]/menu-item:hidden">⌘{index + 1}</SidebarMenuBadge>
          ) : null}
        </SidebarMenuButton>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${space.name}`}
          onClick={() => toggleCollapsed(space.id)}
          className="absolute inset-y-0 left-1 flex w-5 items-center justify-center text-subtle-foreground hover:text-foreground"
        >
          <ChevronRightIcon className={cn("size-3 transition-transform duration-150", !collapsed && "rotate-90")} strokeWidth={2.25} />
        </button>
        <SidebarMenuTrail keep={menu}>
          <Menu open={menu} onOpenChange={setMenu}>
            <MenuTrigger render={<SidebarMenuAction aria-label={`${space.name} actions`} />}>
              <EllipsisIcon />
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
          <SidebarMenuAction aria-label={`New chat in ${space.name}`} onClick={() => void newChat(space.id).catch((e) => toast.error("Couldn’t start a new chat", errorText(e)))}>
            <SquarePenIcon strokeWidth={1.75} />
          </SidebarMenuAction>
        </SidebarMenuTrail>
      </div>
      {collapsed ? null : (
        <SidebarMenuSub className="mt-px">
          {threads?.loading && !threads.data ? (
            [0, 1, 2].map((i) => <SidebarMenuSkeleton key={i} index={i + 1} className="pl-7" />)
          ) : threads?.error && !threads.data ? (
            <RowError className="h-7 pl-7" message="Couldn’t load conversations" onRetry={() => void loadThreads(space.id)} />
          ) : count === 0 ? (
            <li className="flex h-7 items-center pl-7 text-subtle-foreground text-xs">No conversations yet</li>
          ) : (
            <>
              {[...pinned, ...shown].map((t) => (
                <ThreadRow key={t.id} space={space.id} thread={t} active={chatOn && t.current} onDelete={(x) => onDelete(space.id, x)} />
              ))}
              {rest.length > SHOWN ? (
                <li>
                  <SidebarMenuButton size="sm" tone="muted" className="pl-7" onClick={() => setAll((v) => !v)}>
                    {all ? "Show fewer" : `Show ${rest.length - SHOWN} more`}
                  </SidebarMenuButton>
                </li>
              ) : null}
            </>
          )}
        </SidebarMenuSub>
      )}
    </li>
  );
}

/** "Delete “Week 6 notes”?" The conversation and its CLI session go; files it attached stay. */
function ConfirmDeleteThread({ target, onClose }: { target: { space: string; thread: ThreadSummary } | null; onClose: () => void }) {
  const deleteThread = useNav((s) => s.deleteThread);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(target);
  if (target && target !== shown) setShown(target);
  const remove = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await deleteThread(target.space, target.thread.id);
      toast.success("Conversation deleted");
      onClose();
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) {
          setError(null);
          onClose();
        }
      }}
    >
      <AlertDialogPopup className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-lg [overflow-wrap:anywhere]">Delete “{shown?.thread.title}”?</AlertDialogTitle>
          <AlertDialogDescription>Its messages are deleted from this space. Files it attached stay. This can’t be undone.</AlertDialogDescription>
          <FieldError>{error}</FieldError>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button size="sm" variant="ghost" />}>Cancel</AlertDialogClose>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? <Spinner size="sm" /> : null}
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

export function Sidebar() {
  const spaces = useNav((s) => s.spaces);
  const loadSpaces = useNav((s) => s.loadSpaces);
  const openSettings = useNav((s) => s.openSettings);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<{ space: string; thread: ThreadSummary } | null>(null);
  return (
    <Panel aria-label="Spaces and conversations" role="navigation">
      <SidebarRail />
      <SidebarHeader>
        <TopBar />
        <SearchRow />
      </SidebarHeader>
      <SidebarContent className="pt-2 pb-2">
        <SidebarGroup>
          <SidebarGroupLabel>
            Spaces
            <SidebarGroupAction aria-label="New space" onClick={() => setCreating(true)}>
              <PlusIcon strokeWidth={2} />
            </SidebarGroupAction>
          </SidebarGroupLabel>
          {spaces.loading && !spaces.data ? (
            [0, 1, 2, 3].map((i) => <SidebarMenuSkeleton key={i} index={i} icon />)
          ) : spaces.error && !spaces.data ? (
            <RowError className="h-7 px-2" message="Couldn’t load your spaces" onRetry={() => void loadSpaces()} />
          ) : (
            <SidebarMenu className="gap-2">
              {(spaces.data ?? []).map((s, i) => (
                <SpaceGroup key={s.id} space={s} index={i} onDelete={(space, thread) => setDeleting({ space, thread })} />
              ))}
            </SidebarMenu>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <UpdatePill />
        <SidebarMenuButton tone="muted" onClick={() => openSettings()}>
          <Settings2Icon className="size-4" strokeWidth={1.75} />
          <span className="flex-1">Settings</span>
          <Keys keys={keysFor("settings").keys} />
        </SidebarMenuButton>
      </SidebarFooter>
      <NewSpaceDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDeleteThread target={deleting} onClose={() => setDeleting(null)} />
    </Panel>
  );
}
