import { PushPinSimple } from "@phosphor-icons/react";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
  EllipsisIcon,
  FolderOpenIcon,
  MessageSquareIcon,
  PencilLineIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RotateCcwIcon,
  Settings2Icon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion, type Transition } from "motion/react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { BrandMark } from "@/components/brand-mark";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SpaceAvatar } from "@/components/space-avatar";
import { cleanMessage, FieldError, RowError } from "@/components/errors";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
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
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuTrail,
  SidebarRail,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { convState, useChats, useConvState, type ConvState } from "@/features/chat/store";
import { errorText } from "@/lib/core";
import { compactTime, isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { api, type SpaceView } from "./api";
import { keysFor } from "./shortcuts";
import { NewSpaceDialog } from "./NewSpaceDialog";
import { UpdatePill } from "./UpdatePill";
import { chatKey, DRAFT, useNav, type ThreadRow } from "./store";

/**
 * The left panel, after T3 Code's: spaces are groups with their
 * conversations under them, 28 px rows. Every conversation says what it is
 * doing, and several can be busy at once: a status gutter on the left
 * (replying, needs you, new reply, failed, pinned) and a trailing label that
 * names the live state, else the time, giving way to actions on hover.
 * Right-click a conversation or a space for its menu; arrow keys move between
 * rows, F2 renames, Delete asks to delete. Rows slide in and out and move
 * when pinned or reordered. A collapsed space still shows how many of its
 * conversations are busy or waiting. Built on components/ui/sidebar.
 */

const SHOWN = 8;

export function IconButton({ label, keys, onClick, children, className }: { label: string; keys?: string[]; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            onClick={onClick}
            className={cn("app-no-drag inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4.5", className)}
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

/** The sidebar's share of the title bar: the mark, then hide-sidebar and new-chat. */
function TopBar() {
  const toggle = useNav((s) => s.toggleSidebar);
  const space = useNav((s) => s.activeSpace);
  const newChat = useNav((s) => s.newChat);
  return (
    <div className={cn("app-drag flex h-(--titlebar-height) shrink-0 items-center gap-2 border-b pr-2", isMac() ? "pl-(--traffic-light-inset)" : "pl-4")}>
      <BrandMark className="size-4 text-foreground" label="Phaethon" />
      {!isMac() ? <span className="font-medium text-sm tracking-title">Phaethon</span> : null}
      <div className="ml-auto flex items-center gap-0.5">
        <IconButton label="Hide sidebar" keys={keysFor("sidebar").keys} onClick={toggle}>
          <Icon icon={icons.sidebar} />
        </IconButton>
        <IconButton label="New chat" keys={keysFor("newChat").keys} onClick={() => space && void newChat(space)}>
          <Icon icon={icons.newChat} />
        </IconButton>
      </div>
    </div>
  );
}

/** Pinned first (in the order they were pinned), then the rest newest first. */
export function orderThreads(list: ThreadRow[]): { pinned: ThreadRow[]; rest: ThreadRow[] } {
  return {
    pinned: list.filter((t) => t.pinned).sort((a, b) => a.pinned! - b.pinned!),
    rest: list.filter((t) => !t.pinned),
  };
}

// ---- Motion --------------------------------------------------------------------

const EASE: Transition = { type: "spring", stiffness: 520, damping: 42, mass: 0.7 };

/** Rows grow in and fold away; reorders slide. Off when the system asks for less motion. */
function useRowMotion() {
  const reduce = useReducedMotion();
  if (reduce) return {};
  return {
    layout: "position" as const,
    initial: { opacity: 0, height: 0 },
    animate: { opacity: 1, height: "auto" },
    exit: { opacity: 0, height: 0 },
    transition: { ...EASE, opacity: { duration: 0.14 } },
  };
}

// ---- Status --------------------------------------------------------------------

type RowState = ConvState | "unread" | "pinned" | null;

/** A turning arc over a faint ring, so a busy row reads as moving even at 12 px. */
function WorkingMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" className={cn("size-3 shrink-0 text-info-foreground", className)} aria-hidden>
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.75" opacity="0.2" />
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeDasharray="9 20" className="origin-center animate-spin [animation-duration:0.9s]" />
    </svg>
  );
}

function StatusMark({ state }: { state: RowState }) {
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {state ? (
        <motion.span
          key={state}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6 }}
          transition={{ duration: 0.14 }}
          className="flex items-center justify-center"
        >
          {state === "working" ? (
            <WorkingMark />
          ) : state === "waiting" ? (
            <span className="relative flex size-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-warning opacity-50 [animation-duration:1.8s]" />
              <span className="relative size-2 rounded-full bg-warning" />
            </span>
          ) : state === "failed" ? (
            <CircleAlertIcon className="size-3 text-error-foreground" strokeWidth={2.25} />
          ) : state === "unread" ? (
            <span className="size-1.5 rounded-full bg-primary" />
          ) : (
            <PushPinSimple className="size-3 text-subtle-foreground" weight="fill" />
          )}
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

const STATE_LABEL: Partial<Record<NonNullable<RowState>, { text: string; className: string }>> = {
  working: { text: "Working", className: "text-shimmer text-info-foreground" },
  waiting: { text: "Needs you", className: "text-warning-foreground" },
  failed: { text: "Failed", className: "text-error-foreground" },
};

/** A row's state: live work first, then something waiting to be read, then the pin. */
function useRowState(space: string, t: ThreadRow): RowState {
  const live = useConvState(space, t.id);
  const unread = useNav((s) => !!s.unread[chatKey(space, t.id)]);
  // Replying in another window: the core's list knows, this window's store doesn't.
  const elsewhere = useChats((s) => !s.convs[chatKey(space, t.id)] && !!t.running);
  if (live) return live;
  if (elsewhere) return "working";
  if (unread) return "unread";
  if (t.pinned) return "pinned";
  return null;
}

const ROW_LABELS: Record<NonNullable<RowState>, string> = {
  working: "replying",
  waiting: "needs your answer",
  failed: "reply failed",
  unread: "new reply",
  pinned: "pinned",
};

// ---- Rows ----------------------------------------------------------------------

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
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      className="h-7 w-full min-w-0 rounded-md bg-background pr-2 pl-7 text-sm outline-none ring-1 ring-ring"
    />
  );
}

type ThreadActions = { open: () => void; rename: () => void; resetTitle?: () => void; pin: () => void; copy: () => void; remove: () => void; pinned: boolean; busy: boolean };

/** The same actions in the hover menu and the right-click menu. */
function ThreadMenuItems({ a, Item, Separator }: { a: ThreadActions; Item: typeof MenuItem; Separator: typeof MenuSeparator }) {
  return (
    <>
      <Item onClick={a.open}>
        <MessageSquareIcon />
        Open
      </Item>
      <Item onClick={a.rename}>
        <PencilLineIcon />
        Rename
        <span className="ml-auto pl-4 text-2xs text-muted-foreground">F2</span>
      </Item>
      {a.resetTitle ? (
        <Item onClick={a.resetTitle}>
          <RotateCcwIcon />
          Reset title
        </Item>
      ) : null}
      <Item onClick={a.pin}>
        {a.pinned ? <PinOffIcon /> : <PinIcon />}
        {a.pinned ? "Unpin" : "Pin to top"}
      </Item>
      <Item onClick={a.copy}>
        <CopyIcon />
        Copy title
      </Item>
      <Separator />
      <Item variant="destructive" disabled={a.busy} onClick={a.remove}>
        <Trash2Icon />
        Delete…
      </Item>
    </>
  );
}

function ThreadRowItem({ space, thread, active, onDelete }: { space: string; thread: ThreadRow; active: boolean; onDelete: (t: ThreadRow) => void }) {
  const openThread = useNav((s) => s.openThread);
  const renameThread = useNav((s) => s.renameThread);
  const pinThread = useNav((s) => s.pinThread);
  const state = useRowState(space, thread);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const rowMotion = useRowMotion();
  const busy = state === "working" || state === "waiting";
  const label = STATE_LABEL[state as keyof typeof STATE_LABEL];

  const rename = (title: string | null) => {
    setRenaming(false);
    if (title === null || title.trim() === thread.title) return;
    void renameThread(space, thread.id, title).catch((e) => toast.error("Couldn’t rename the conversation", errorText(e)));
  };
  const actions: ThreadActions = {
    open: () => void openThread(space, thread.id),
    rename: () => setRenaming(true),
    resetTitle: thread.renamed ? () => rename("") : undefined,
    pin: () => {
      const on = !thread.pinned;
      void pinThread(space, thread.id, on).catch((e) => toast.error(on ? "Couldn’t pin the conversation" : "Couldn’t unpin the conversation", errorText(e)));
    },
    copy: () =>
      void navigator.clipboard.writeText(thread.title).then(
        () => toast.success("Title copied"),
        () => toast.error("Couldn’t copy the title"),
      ),
    remove: () => onDelete(thread),
    pinned: !!thread.pinned,
    busy,
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "F2") {
      e.preventDefault();
      setRenaming(true);
    } else if ((e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) && !busy) {
      e.preventDefault();
      onDelete(thread);
    }
  };

  return (
    <motion.li {...rowMotion} className="group/menu-item relative overflow-hidden" data-slot="sidebar-menu-item" data-keep={menu || undefined}>
      {renaming ? (
        <RenameField initial={thread.title} onDone={rename} />
      ) : (
        <ContextMenu>
          <ContextMenuTrigger className="relative block">
            <SidebarMenuButton
              isActive={active}
              aria-current={active ? "page" : undefined}
              aria-label={state ? `${thread.title}, ${ROW_LABELS[state]}` : thread.title}
              data-nav-row=""
              data-state={state ?? undefined}
              onClick={actions.open}
              onKeyDown={onKeyDown}
              className={cn("pl-7", state === "unread" && "font-medium text-foreground")}
            >
              <Truncate side="right" className="flex-1">
                {thread.title}
              </Truncate>
              {label ? (
                <SidebarMenuBadge className={cn("font-medium", label.className)}>{label.text}</SidebarMenuBadge>
              ) : thread.messages ? (
                <SidebarMenuBadge>{compactTime(thread.updated)}</SidebarMenuBadge>
              ) : null}
            </SidebarMenuButton>
            <span className="pointer-events-none absolute inset-y-0 left-2 flex w-4 items-center justify-center">
              <StatusMark state={state} />
            </span>
            <SidebarMenuTrail keep={menu}>
              <Menu open={menu} onOpenChange={setMenu}>
                <MenuTrigger render={<SidebarMenuAction aria-label="Conversation actions" />}>
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="start" side="right">
                  <ThreadMenuItems a={actions} Item={MenuItem} Separator={MenuSeparator} />
                </MenuPopup>
              </Menu>
            </SidebarMenuTrail>
          </ContextMenuTrigger>
          <ContextMenuPopup>
            <ThreadMenuItems a={actions} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
          </ContextMenuPopup>
        </ContextMenu>
      )}
    </motion.li>
  );
}

/** The space's new chat while it is open: a row so a click on New chat visibly lands somewhere. */
function DraftRow({ space, active }: { space: string; active: boolean }) {
  const newChat = useNav((s) => s.newChat);
  const rowMotion = useRowMotion();
  return (
    <motion.li {...rowMotion} className="group/menu-item relative overflow-hidden" data-slot="sidebar-menu-item">
      <SidebarMenuButton isActive={active} aria-current={active ? "page" : undefined} data-nav-row="" onClick={() => void newChat(space)} className="pl-7 text-muted-foreground">
        <span className="pointer-events-none absolute inset-y-0 left-2 flex w-4 items-center justify-center">
          <SquarePenIcon className="size-3" strokeWidth={2} />
        </span>
        <span className="flex-1 truncate">New chat</span>
      </SidebarMenuButton>
    </motion.li>
  );
}

/** How many of a space's conversations are replying and waiting, and whether any has a new reply. */
function useSpaceActivity(space: string, threads: ThreadRow[] | undefined) {
  const prefix = `${space}/`;
  const local = useChats(
    useShallow((s) => {
      let working = 0;
      let waiting = 0;
      const seen: string[] = [];
      for (const [key, c] of Object.entries(s.convs)) {
        if (!key.startsWith(prefix)) continue;
        seen.push(key.slice(prefix.length));
        const st = convState(c);
        if (st === "working") working++;
        else if (st === "waiting") waiting++;
      }
      return { working, waiting, seen: seen.join(",") };
    }),
  );
  const known = new Set(local.seen.split(","));
  const elsewhere = (threads ?? []).filter((t) => t.running && !known.has(t.id)).length;
  const unread = useNav((s) => Object.keys(s.unread).some((k) => k.startsWith(prefix)));
  return { working: local.working + elsewhere, waiting: local.waiting, unread };
}

function SpaceMenuItems({ space, Item }: { space: SpaceView; Item: typeof MenuItem }) {
  const newChat = useNav((s) => s.newChat);
  const openSettings = useNav((s) => s.openSettings);
  return (
    <>
      <Item onClick={() => void newChat(space.id)}>
        <SquarePenIcon />
        New chat
      </Item>
      <Item onClick={() => void api.showSpace(space.id).catch((e) => toast.error("Couldn’t show the folder", errorText(e)))}>
        <FolderOpenIcon />
        Show folder
      </Item>
      <Item onClick={() => openSettings("spaces")}>
        <Settings2Icon />
        Space settings
      </Item>
    </>
  );
}

function SpaceGroup({ space, index, onDelete }: { space: SpaceView; index: number; onDelete: (space: string, t: ThreadRow) => void }) {
  const active = useNav((s) => s.activeSpace === space.id);
  const view = useNav((s) => s.view);
  const settingsOpen = useNav((s) => s.settings !== null);
  const threads = useNav((s) => s.threads[space.id]);
  const open = useNav((s) => s.open[space.id]);
  const collapsed = useNav((s) => !!s.collapsed[space.id]);
  const toggleCollapsed = useNav((s) => s.toggleCollapsed);
  const selectSpace = useNav((s) => s.selectSpace);
  const newChat = useNav((s) => s.newChat);
  const loadThreads = useNav((s) => s.loadThreads);
  const [all, setAll] = useState(false);
  const [menu, setMenu] = useState(false);
  const activity = useSpaceActivity(space.id, threads?.data);
  const { pinned, rest } = orderThreads(threads?.data ?? []);
  const count = pinned.length + rest.length;
  // A busy or selected conversation stays in view even past the fold.
  const shown = all ? rest : rest.filter((t, i) => i < SHOWN || t.id === open || t.running);
  const chatOn = active && !settingsOpen && view === "chat";
  const draftOpen = open === DRAFT && active;
  const hideOnHover = "group-hover/menu-item:hidden group-has-focus-visible/menu-item:hidden group-data-[keep=true]/menu-item:hidden";

  return (
    <li className="flex flex-col">
      <ContextMenu>
        <ContextMenuTrigger className="group/menu-item relative block" data-keep={menu || undefined}>
          <SidebarMenuButton
            aria-label={`Go to ${space.name}`}
            data-nav-row=""
            onClick={() => selectSpace(space.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" && collapsed) toggleCollapsed(space.id);
              else if (e.key === "ArrowLeft" && !collapsed) toggleCollapsed(space.id);
            }}
            className="pl-6 group-hover/menu-item:pr-12 group-has-focus-visible/menu-item:pr-12 group-data-[keep=true]/menu-item:pr-12"
          >
            <SpaceAvatar name={space.name} hue={space.hue} />
            <Truncate className={cn("flex-1 font-medium", active && !settingsOpen ? "text-foreground" : "text-sidebar-foreground/90")}>{space.name}</Truncate>
            {collapsed ? (
              <span className={cn("ml-auto flex shrink-0 items-center gap-1.5 pl-1", hideOnHover)}>
                {activity.working ? (
                  <span className="flex items-center gap-1 text-2xs text-info-foreground tabular-nums" aria-label={`${activity.working} replying`}>
                    <WorkingMark />
                    {activity.working > 1 ? activity.working : null}
                  </span>
                ) : null}
                {activity.waiting ? <span className="size-2 rounded-full bg-warning" aria-label={`${activity.waiting} need you`} /> : null}
                {activity.unread ? <span className="size-1.5 rounded-full bg-primary" aria-label="New reply" /> : null}
                {count ? <span className="min-w-4 text-right text-2xs text-subtle-foreground tabular-nums">{count}</span> : null}
              </span>
            ) : index < 9 && isMac() ? (
              <SidebarMenuBadge className="text-3xs">⌘{index + 1}</SidebarMenuBadge>
            ) : null}
          </SidebarMenuButton>
          <button
            type="button"
            tabIndex={-1}
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
                <SpaceMenuItems space={space} Item={MenuItem} />
              </MenuPopup>
            </Menu>
            <SidebarMenuAction aria-label={`New chat in ${space.name}`} onClick={() => void newChat(space.id)}>
              <SquarePenIcon strokeWidth={1.75} />
            </SidebarMenuAction>
          </SidebarMenuTrail>
        </ContextMenuTrigger>
        <ContextMenuPopup>
          <SpaceMenuItems space={space} Item={ContextMenuItem} />
        </ContextMenuPopup>
      </ContextMenu>
      <AnimatePresence initial={false}>
        {collapsed ? null : (
          <motion.div
            key="list"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ ...EASE, opacity: { duration: 0.12 } }}
            className="overflow-hidden"
          >
            <SidebarMenuSub className="mt-px" aria-label={`${space.name} conversations`}>
              {threads?.loading && !threads.data ? (
                [0, 1, 2].map((i) => <SidebarMenuSkeleton key={i} index={i + 1} className="pl-7" />)
              ) : threads?.error && !threads.data ? (
                <RowError className="h-7 pl-7" message="Couldn’t load conversations" onRetry={() => void loadThreads(space.id)} />
              ) : (
                <LayoutGroup id={`threads-${space.id}`}>
                  <AnimatePresence initial={false}>
                    {draftOpen ? <DraftRow key={DRAFT} space={space.id} active={chatOn} /> : null}
                    {[...pinned, ...shown].map((t) => (
                      <ThreadRowItem key={t.id} space={space.id} thread={t} active={chatOn && open === t.id} onDelete={(x) => onDelete(space.id, x)} />
                    ))}
                  </AnimatePresence>
                  {count === 0 && !draftOpen ? <li className="flex h-7 items-center pl-7 text-subtle-foreground text-xs">No conversations yet</li> : null}
                  {rest.length > SHOWN ? (
                    <li>
                      <SidebarMenuButton size="sm" tone="muted" className="pl-7" data-nav-row="" onClick={() => setAll((v) => !v)}>
                        {all ? "Show fewer" : `Show ${rest.length - shown.length} more`}
                      </SidebarMenuButton>
                    </li>
                  ) : null}
                </LayoutGroup>
              )}
            </SidebarMenuSub>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

/** "Delete “Week 6 notes”?" The conversation and its CLI session go; files it attached stay. */
function ConfirmDeleteThread({ target, onClose }: { target: { space: string; thread: ThreadRow } | null; onClose: () => void }) {
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

/** Up and Down move between rows, Home and End to the first and last. */
function moveFocus(e: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-nav-row]")];
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : e.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
  e.preventDefault();
  rows[next]?.focus();
}

export function Sidebar() {
  const spaces = useNav((s) => s.spaces);
  const loadSpaces = useNav((s) => s.loadSpaces);
  const openSettings = useNav((s) => s.openSettings);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<{ space: string; thread: ThreadRow } | null>(null);
  return (
    <Panel aria-label="Spaces and conversations" role="navigation">
      <SidebarRail />
      <SidebarHeader>
        <TopBar />
      </SidebarHeader>
      <SidebarContent className="pt-2 pb-2" onKeyDown={moveFocus}>
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
