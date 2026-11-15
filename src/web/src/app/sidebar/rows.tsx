import { usePresence } from "motion/react";
import { memo, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { RowError } from "@/components/errors";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuSkeleton, SidebarMenuTrail } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { useChats, useConvState, type ConvState } from "@/features/chat/store";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import { chatKey, useNav, type ThreadRow } from "../store";
import { useList, type ListContextValue } from "./list-context";

/**
 * A conversation row and the pieces around it. Rows are cheap to mount,
 * since the windowed list mounts a few on every scroll step: no menu of
 * their own (the "…" trigger opens the list's one shared menu and the list
 * owns the right-click menu), no motion components, and the title measures
 * whether it is cut only when hovered.
 */

type RowState = ConvState | "unread" | "pinned" | null;

/** The spinner arc, in the info blue, so a busy row reads as moving even at 12 px. */
export function WorkingMark({ className }: { className?: string }) {
  return <Spinner size="xs" aria-hidden role={undefined} aria-label={undefined} className={cn("text-info-foreground", className)} />;
}

/** The status gutter. A change of state pops the new mark in; a row scrolling in shows its mark as it is. */
function StatusMark({ state }: { state: RowState }) {
  const first = useRef(state);
  const changed = state !== first.current;
  return (
    <span key={state ?? "idle"} className={cn("flex items-center justify-center", changed && "animate-in fade-in zoom-in-50 duration-150")}>
      {state === "working" ? (
        <WorkingMark />
      ) : state === "waiting" ? (
        <span className="relative flex size-2">
          <span className="absolute inset-0 animate-ping rounded-full bg-warning opacity-50 [animation-duration:1.8s]" />
          <span className="relative size-2 rounded-full bg-warning" />
        </span>
      ) : state === "failed" ? (
        <Icon icon={icons.error} className="size-3 text-error-foreground" />
      ) : state === "unread" ? (
        <span className="size-1.5 rounded-full bg-primary" />
      ) : state === "pinned" ? (
        <Icon icon={icons.pin} className="size-3 text-subtle-foreground" />
      ) : (
        <span className="size-1.5 rounded-full border border-subtle-foreground/60" />
      )}
    </span>
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

// ---- Actions -------------------------------------------------------------------

type ThreadActions = { open: () => void; rename: () => void; resetTitle?: () => void; pin: () => void; copy: () => void; remove: () => void; pinned: boolean; busy: boolean };

/** What can be done to a conversation. A row the filter found further back joins the space's list before anything changes it. */
function threadActions(list: ListContextValue, key: string, space: string, thread: ThreadRow, busy: boolean): ThreadActions {
  const nav = () => useNav.getState();
  const ensure = () => nav().ensureThread(space, thread);
  return {
    open: () => {
      ensure();
      void nav().openThread(space, thread.id);
    },
    rename: () => list.rename(key),
    resetTitle: thread.renamed ? () => renameTo(space, thread, "") : undefined,
    pin: () => {
      const on = !thread.pinned;
      ensure();
      void nav()
        .pinThread(space, thread.id, on)
        .catch((e) => toast.error(on ? "Couldn’t pin the conversation" : "Couldn’t unpin the conversation", errorText(e)));
    },
    copy: () =>
      void navigator.clipboard.writeText(thread.title).then(
        () => toast.success("Title copied"),
        () => toast.error("Couldn’t copy the title"),
      ),
    remove: () => list.onDelete(space, thread),
    pinned: !!thread.pinned,
    busy,
  };
}

function renameTo(space: string, thread: ThreadRow, title: string | null) {
  if (title === null || title.trim() === thread.title) return;
  useNav.getState().ensureThread(space, thread);
  void useNav
    .getState()
    .renameThread(space, thread.id, title)
    .catch((e) => toast.error("Couldn’t rename the conversation", errorText(e)));
}

/** The same actions in the "…" menu and the right-click menu. */
export function ThreadMenuItems({ itemKey, space, thread, Item, Separator }: { itemKey: string; space: string; thread: ThreadRow; Item: typeof MenuItem; Separator: typeof MenuSeparator }) {
  const list = useList();
  const state = useRowState(space, thread);
  const a = threadActions(list, itemKey, space, thread, state === "working" || state === "waiting");
  return (
    <>
      <Item onClick={a.open}>
        <Icon icon={icons.chat} />
        Open
      </Item>
      <Item onClick={a.rename}>
        <Icon icon={icons.rename} />
        Rename
        <span className="ml-auto pl-4 text-2xs text-muted-foreground">F2</span>
      </Item>
      {a.resetTitle ? (
        <Item onClick={a.resetTitle}>
          <Icon icon={icons.undo} />
          Reset title
        </Item>
      ) : null}
      <Item onClick={a.pin}>
        <Icon icon={a.pinned ? icons.unpin : icons.pin} />
        {a.pinned ? "Unpin" : "Pin to top"}
      </Item>
      <Item onClick={a.copy}>
        <Icon icon={icons.copy} />
        Copy title
      </Item>
      <Separator />
      <Item variant="destructive" disabled={a.busy} onClick={a.remove}>
        <Icon icon={icons.delete} />
        Delete…
      </Item>
    </>
  );
}

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
      className="h-7 w-full min-w-0 rounded-md bg-background pr-2 pl-8 text-sm text-foreground outline-none ring-1 ring-ring ring-inset"
    />
  );
}

export type RowProps = { itemKey: string; space: string; thread: ThreadRow; active: boolean; renaming: boolean; menuOpen: boolean };

function ThreadRowItem({ itemKey, space, thread, active, renaming, menuOpen }: RowProps) {
  const list = useList();
  const state = useRowState(space, thread);
  const busy = state === "working" || state === "waiting";
  const label = STATE_LABEL[state as keyof typeof STATE_LABEL];
  const open = () => {
    useNav.getState().ensureThread(space, thread);
    void useNav.getState().openThread(space, thread.id);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "F2") {
      e.preventDefault();
      list.rename(itemKey);
    } else if ((e.key === "Delete" || (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) && !busy) {
      e.preventDefault();
      list.onDelete(space, thread);
    }
  };
  const mark = (
    <span className="pointer-events-none absolute inset-y-0 left-2 flex w-4 items-center justify-center">
      <StatusMark state={state} />
    </span>
  );

  if (renaming) {
    return (
      <div className="relative">
        <RenameField
          initial={thread.title}
          onDone={(title) => {
            list.rename(null);
            renameTo(space, thread, title);
          }}
        />
        {mark}
      </div>
    );
  }
  return (
    <div className="group/menu-item relative" data-slot="sidebar-menu-item" data-keep={menuOpen || undefined}>
      <SidebarMenuButton
        isActive={active}
        aria-current={active ? "page" : undefined}
        aria-label={state ? `${thread.title}, ${ROW_LABELS[state]}` : thread.title}
        data-nav-row=""
        data-state={state ?? undefined}
        onClick={open}
        onKeyDown={onKeyDown}
        className={cn("pl-8", state === "unread" && "font-medium text-foreground")}
      >
        <Truncate lazy side="right" className="flex-1">
          {thread.title}
        </Truncate>
        {label ? <SidebarMenuBadge className={cn("font-medium", label.className)}>{label.text}</SidebarMenuBadge> : null}
      </SidebarMenuButton>
      {mark}
      <SidebarMenuTrail keep={menuOpen}>
        <MenuTrigger handle={list.rowMenu} payload={itemKey} render={<SidebarMenuAction aria-label="Conversation actions" />}>
          <Icon icon={icons.more} />
        </MenuTrigger>
      </SidebarMenuTrail>
    </div>
  );
}

/**
 * One windowed row at its offset in its group. It slides when rows above it
 * come or go, fades in when it is new to the list (not when it scrolls in),
 * and fades out when it is deleted (not when it scrolls out).
 */
export const RowSlot = memo(function RowSlot({ y, fresh, ...row }: RowProps & { y: number; fresh: boolean }) {
  const list = useList();
  const [present, safeToRemove] = usePresence();
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (present) return;
    if (list.instant() || list.listed(row.itemKey)) {
      safeToRemove();
      return;
    }
    setLeaving(true);
    const t = setTimeout(safeToRemove, 160);
    return () => clearTimeout(t);
  }, [present, safeToRemove, list, row.itemKey]);
  return (
    <li
      data-slide=""
      data-item-key={row.itemKey}
      className={cn("absolute inset-x-0 top-0 h-7", fresh && !leaving && "animate-in fade-in duration-200", leaving && "pointer-events-none opacity-0 transition-opacity duration-150")}
      style={{ transform: `translateY(${y}px)` }}
    >
      <ThreadRowItem {...row} />
    </li>
  );
});

/** The quiet row at the end of the loaded run: a skeleton while the next page loads, or a retry when it couldn't. */
export function LoaderRow({ space, failed, y }: { space: string; failed: boolean; y: number }) {
  const list = useList();
  return (
    <li data-slide="" className="absolute inset-x-0 top-0 h-7" style={{ transform: `translateY(${y}px)` }}>
      {failed ? (
        <RowError className="h-7 pl-8" message="Couldn’t load older conversations" onRetry={() => list.retryMore(space)} />
      ) : (
        <SidebarMenuSkeleton index={3} className="pl-8" />
      )}
    </li>
  );
}
