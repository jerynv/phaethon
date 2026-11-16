import { useVirtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { RowError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuPopup, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from "@/components/ui/menu";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { RowHighlight } from "@/components/ui/row-highlight";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { FileIcon } from "@/features/viewer/FileIcon";
import { fileManagerName, isMac, relativeTime } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/features/chat/lib/attachments";
import { type FileEntry, itemCount, parentOf } from "../api";
import type { Row } from "../lib/tree";

export type ItemActions = {
  /** A file into the viewer; a folder becomes the one on show. */
  open: (e: FileEntry) => void;
  openExternal: (e: FileEntry) => void;
  reveal: (e: FileEntry) => void;
  rename: (e: FileEntry) => void;
  move: (e: FileEntry) => void;
  remove: (e: FileEntry) => void;
  copyPath: (e: FileEntry) => void;
};

const ROW = 32;
/** Indent per level, and the row's own inset. */
const STEP = 16;
const INSET = 8;

/** The columns, shared by the header row and every row, so they line up. */
export const COL_MODIFIED = "w-28 shrink-0 text-right @max-md/files:hidden";
export const COL_SIZE = "w-20 shrink-0 text-right @max-2xs/files:hidden";
export const COL_MORE = "w-7 shrink-0";

/** One menu for a file or folder, drawn in the row's … menu and its right-click menu. */
function ItemMenu({ entry, actions }: { entry: FileEntry; actions: ItemActions }) {
  return (
    <>
      <MenuItem onClick={() => actions.open(entry)}>
        <Icon icon={entry.dir ? icons.folderOpen : icons.view} />
        Open
      </MenuItem>
      {!entry.dir ? (
        <MenuItem onClick={() => actions.openExternal(entry)}>
          <Icon icon={icons.external} />
          Open in default app
        </MenuItem>
      ) : null}
      <MenuItem onClick={() => actions.reveal(entry)}>
        <Icon icon={icons.folder} />
        Show in {fileManagerName()}
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => actions.rename(entry)}>
        <Icon icon={icons.rename} />
        Rename…
        <MenuShortcut>F2</MenuShortcut>
      </MenuItem>
      <MenuItem onClick={() => actions.move(entry)}>
        <Icon icon={icons.arrowRight} />
        Move to folder…
      </MenuItem>
      <MenuItem onClick={() => actions.copyPath(entry)}>
        <Icon icon={icons.copy} />
        Copy path
      </MenuItem>
      <MenuSeparator />
      <MenuItem variant="destructive" onClick={() => actions.remove(entry)}>
        <Icon icon={icons.delete} />
        Delete…
        <MenuShortcut>{isMac() ? "⌘⌫" : "Del"}</MenuShortcut>
      </MenuItem>
    </>
  );
}

/**
 * The space's files as a windowed tree (docs/UI-REBUILD.md › Courses' tree
 * for density): folders first, each with its count, opening in place; files
 * open in the viewer. One `tree` holds focus and points at its active row
 * (`aria-activedescendant`), so the rows can mount and unmount while
 * scrolling. Arrows move, → and ← open and close folders, Enter opens (a
 * folder becomes the one on show), F2 renames, Delete deletes, Shift+F10
 * opens the row's menu.
 */
export function FileTree({
  rows,
  label,
  active,
  onActive,
  onToggle,
  onMore,
  onRetry,
  actions,
  flat = false,
  metaFor,
  instant,
  empty,
  lockedRoots = [],
}: {
  rows: Row[];
  label: string;
  active: string | null;
  onActive: (key: string | null) => void;
  onToggle: (e: FileEntry, open?: boolean) => void;
  onMore: (folder: string) => void;
  onRetry: (folder: string) => void;
  actions: ItemActions;
  /** A flat list (search, Recent, Used in chats): each file shows its folder. */
  flat?: boolean;
  /** Replaces the Modified column ("Read 2 h ago"). */
  metaFor?: (e: FileEntry) => string;
  /** The list was swapped wholesale: the selection appears in place. */
  instant?: boolean;
  empty?: ReactNode;
  /** The folders kept from Phaethon's agent: their rows carry the lock (rows inside them only when shown on their own). */
  lockedRoots?: string[];
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prefix = useId();
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 12,
    getItemKey: (i) => rows[i]?.key ?? i,
  });
  const activeIndex = active === null ? -1 : rows.findIndex((r) => r.key === active);
  const idOf = (i: number) => `${prefix}-row-${i}`;

  // Keep the active row on screen as it moves.
  useEffect(() => {
    if (activeIndex >= 0) virtualizer.scrollToIndex(activeIndex, { align: "auto" });
  }, [activeIndex, virtualizer]);

  const move = (to: number) => {
    if (!rows.length) return;
    const i = Math.max(0, Math.min(rows.length - 1, to));
    onActive(rows[i]!.key);
  };

  const activate = (r: Row, viaKey: boolean) => {
    if (r.kind === "entry") {
      if (r.entry.dir && !viaKey) onToggle(r.entry);
      else actions.open(r.entry);
    } else if (r.kind === "more") onMore(r.parent);
    else if (r.kind === "error") onRetry(r.parent);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const i = activeIndex;
    const r = i >= 0 ? rows[i] : undefined;
    const entry = r?.kind === "entry" ? r.entry : undefined;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? ROW * 10) / ROW) - 1);
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        move(i < 0 ? 0 : i + 1);
        break;
      case "ArrowUp":
        move(i < 0 ? 0 : i - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "PageDown":
        move(i + page);
        break;
      case "PageUp":
        move(i - page);
        break;
      case "ArrowRight":
        if (entry?.dir && r?.kind === "entry" && !flat) {
          if (!r.expanded) onToggle(entry, true);
          else if (rows[i + 1] && rows[i + 1]!.level > r.level) move(i + 1);
        } else handled = false;
        break;
      case "ArrowLeft":
        if (r?.kind === "entry" && r.expanded) onToggle(r.entry, false);
        else if (r && r.level > 1) {
          const up = rows.findIndex((x) => x.kind === "entry" && x.entry.path === r.parent);
          if (up >= 0) move(up);
        } else handled = false;
        break;
      case "Enter":
        if (r) activate(r, true);
        break;
      case " ":
        if (r) activate(r, false);
        break;
      case "F2":
        if (entry) actions.rename(entry);
        break;
      case "Delete":
        if (entry) actions.remove(entry);
        break;
      case "Backspace":
        if (entry && (e.metaKey || e.ctrlKey)) actions.remove(entry);
        else handled = false;
        break;
      case "ContextMenu":
      case "F10":
        if (e.key === "F10" && !e.shiftKey) {
          handled = false;
          break;
        }
        if (i >= 0) scrollRef.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(idOf(i))} [data-row-more]`)?.click();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };

  const items = virtualizer.getVirtualItems();
  const activeItem = activeIndex >= 0 ? { top: activeIndex * ROW, height: ROW } : null;

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={activeIndex >= 0 ? idOf(activeIndex) : undefined}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target === e.currentTarget && activeIndex < 0 && rows.length) onActive(rows[0]!.key);
      }}
      className="group/tree min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-1 outline-none [scrollbar-width:thin]"
    >
      {rows.length === 0 ? (
        empty
      ) : (
        <div className="relative isolate w-full" style={{ height: virtualizer.getTotalSize() }}>
          <RowHighlight id={active} box={activeItem} instant={instant} />
          {items.map((v) => {
            const r = rows[v.index]!;
            return (
              <div key={v.key} className="absolute inset-x-0 top-0" style={{ transform: `translateY(${v.start}px)`, height: ROW }}>
                <TreeRow
                  row={r}
                  id={idOf(v.index)}
                  active={v.index === activeIndex}
                  flat={flat}
                  metaFor={metaFor}
                  actions={actions}
                  onPress={() => {
                    onActive(r.key);
                    activate(r, false);
                    scrollRef.current?.focus({ preventScroll: true });
                  }}
                  onDoubleOpen={() => r.kind === "entry" && r.entry.dir && actions.open(r.entry)}
                  onToggle={() => r.kind === "entry" && onToggle(r.entry)}
                  onMenu={() => onActive(r.key)}
                  lock={
                    r.kind === "entry" &&
                    !!r.entry.excluded &&
                    (flat || r.level === 1 || lockedRoots.some((f) => f.toLowerCase() === r.entry.path.toLowerCase()))
                  }
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TreeRow({
  row: r,
  id,
  active,
  flat,
  metaFor,
  actions,
  onPress,
  onDoubleOpen,
  onToggle,
  onMenu,
  lock,
}: {
  row: Row;
  id: string;
  active: boolean;
  flat: boolean;
  metaFor?: (e: FileEntry) => string;
  actions: ItemActions;
  onPress: () => void;
  onDoubleOpen: () => void;
  onToggle: () => void;
  onMenu: () => void;
  lock: boolean;
}) {
  const pad = { paddingLeft: INSET + (r.level - 1) * STEP };
  const base = cn(
    "flex h-8 w-full cursor-default select-none items-center gap-2 rounded-md pr-1 text-sm outline-none transition-colors",
    !active && "hover:bg-accent",
    "group-focus-visible/tree:data-active:ring-2 group-focus-visible/tree:data-active:ring-ring group-focus-visible/tree:data-active:ring-inset",
  );
  if (r.kind !== "entry") {
    const text =
      r.kind === "more" ? `Show ${r.left.toLocaleString()} more` : r.kind === "loading" ? "Loading…" : r.kind === "empty" ? "Empty folder" : r.message;
    return (
      <div
        id={id}
        role="treeitem"
        aria-level={r.level}
        aria-selected={active}
        aria-label={text}
        data-active={active || undefined}
        style={pad}
        className={base}
        onClick={onPress}
      >
        <span className="w-4 shrink-0" />
        {r.kind === "loading" ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Spinner size="sm" tone="muted" />
            Loading…
          </span>
        ) : r.kind === "more" ? (
          <span className="text-primary">{text}</span>
        ) : r.kind === "empty" ? (
          <span className="text-muted-foreground">Empty folder</span>
        ) : (
          <RowError message={r.message} onRetry={onPress} className="min-w-0 flex-1" />
        )}
      </div>
    );
  }
  const e = r.entry;
  const folder = flat ? parentOf(e.path) : "";
  const meta = metaFor ? metaFor(e) : relativeTime(e.modified);
  const size = e.dir ? itemCount(e.count ?? 0) : formatBytes(e.size);
  const hidden = e.name.startsWith(".");
  const label = `${e.name}${folder ? `, in ${folder}` : ""}, ${e.dir ? `folder, ${size}` : size}${e.excluded ? ", kept from Phaethon’s agent" : ""}, ${meta}`;
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <div
            id={id}
            role="treeitem"
            aria-level={r.level}
            aria-setsize={r.setSize}
            aria-posinset={r.pos}
            aria-expanded={e.dir && !flat ? r.expanded : undefined}
            aria-selected={active}
            aria-label={label}
            data-active={active || undefined}
            data-path={e.path}
            style={pad}
            className={cn(base, "group/row")}
            onClick={onPress}
            onDoubleClick={onDoubleOpen}
            onContextMenu={onMenu}
          />
        }
      >
        <span
          aria-hidden
          className="flex w-4 shrink-0 justify-center"
          onClick={(ev) => {
            if (!e.dir || flat) return;
            ev.stopPropagation();
            onToggle();
          }}
        >
          {e.dir && !flat ? (
            <Icon icon={icons.chevronRight} className={cn("size-3.5 text-muted-foreground transition-transform", r.expanded && "rotate-90")} />
          ) : null}
        </span>
        {e.dir ? (
          <Icon icon={r.expanded ? icons.folderOpen : icons.folder} className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <FileIcon name={e.name} className="shrink-0" />
        )}
        <span className={cn("flex min-w-0 flex-1 items-baseline gap-2", hidden && "text-muted-foreground")}>
          <MiddleTruncate value={e.name} showTitle={false} className="min-w-0 shrink" />
          {lock ? (
            <Tooltip>
              <TooltipTrigger render={<span className="flex shrink-0 self-center" data-testid="excluded-lock" />}>
                <Icon icon={icons.locked} className="size-3.5 text-subtle-foreground" />
              </TooltipTrigger>
              <TooltipPopup>Phaethon’s agent can’t read this folder</TooltipPopup>
            </Tooltip>
          ) : null}
          {folder ? <MiddleTruncate value={folder} showTitle={false} className="type-meta min-w-0 shrink-[2]" /> : null}
        </span>
        <span className={cn("type-meta truncate", COL_MODIFIED)}>{meta}</span>
        <span className={cn("type-meta truncate", COL_SIZE)}>{size}</span>
        <span className={cn("flex justify-end", COL_MORE)}>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  tabIndex={-1}
                  data-row-more=""
                  aria-label={`${e.name} actions`}
                  className="opacity-0 group-hover/row:opacity-100 group-data-active/row:opacity-100 data-popup-open:opacity-100"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onMenu();
                  }}
                  onDoubleClick={(ev) => ev.stopPropagation()}
                />
              }
            >
              <Icon icon={icons.more} />
            </MenuTrigger>
            <MenuPopup align="end">
              <ItemMenu entry={e} actions={actions} />
            </MenuPopup>
          </Menu>
        </span>
      </ContextMenuTrigger>
      <ContextMenuPopup>
        <ItemMenu entry={e} actions={actions} />
      </ContextMenuPopup>
    </ContextMenu>
  );
}
