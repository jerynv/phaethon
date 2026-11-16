import { useCallback, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { cleanMessage, FieldError, RowError } from "@/components/errors";
import { toast } from "@/components/toast";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Sidebar as Panel,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRail,
} from "@/components/ui/sidebar";
import { errorText } from "@/lib/core";
import type { SpaceView } from "./api";
import { keysFor, viewKeys } from "./shortcuts";
import { NewSpaceDialog } from "./NewSpaceDialog";
import { UpdatePill } from "./UpdatePill";
import { FilterField, useThreadFilter } from "./sidebar/filter";
import { foldTitle } from "./sidebar/layout";
import { SpacesList, type SpacesListHandle } from "./sidebar/SpacesList";
import { SpaceSwitcher } from "./sidebar/space-switcher";
import { DRAFT, useActiveSpace, useNav, type ThreadRow, type View } from "./store";
import { VIEWS } from "./views";

/**
 * The left panel (references a163, 3940, 9334): the space switcher, then one
 * search field with New chat beside it, the space's pages, and the space's
 * conversations as its recents, grouped by recency (Pinned, Today,
 * Yesterday, Previous 7 days, Previous 30 days, then by month) under sticky
 * labels, 28 px rows on a 16 px icon column, and a quiet footer.
 *
 * One space at a time: the switcher's menu holds every space (and what each
 * is busy with), so spaces never compete for height. A switch brings the new
 * space's list in with its rows stepping in, and a sweep under the switcher
 * while it loads.
 *
 * Built for thousands of conversations (./sidebar/): the rows are a windowed
 * list, so only the rows on screen exist, and older pages load as the end of
 * the loaded run scrolls into view. The search narrows the loaded rows at
 * once and asks the core for the rest; its keys (⌘K) open the full-text
 * search over every space. A conversation opened from search scrolls into
 * view, read on its own when it is older than the loaded pages.
 *
 * Every conversation says what it is doing, and several can be busy at once:
 * a status mark in the icon column (replying, needs you, new reply, failed,
 * pinned), named in the row's accessible name; actions show on hover.
 * Right-click a conversation for its menu; arrow keys move between rows, F2
 * renames, Delete asks to delete. Built on components/ui/sidebar.
 */

function Keys({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <KbdGroup className={className}>
      {keys.map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </KbdGroup>
  );
}

/** "Delete “Week 6 notes”?" The conversation and its CLI session go; files it attached stay. */
function ConfirmDeleteThread({
  target,
  onClose,
  onDeleted,
  refocus,
}: {
  target: { space: string; thread: ThreadRow } | null;
  onClose: () => void;
  onDeleted: (space: string, id: string) => void;
  /** After a delete, focuses the row now in the deleted one's place (the deleted row can't take focus back); false when there is none. */
  refocus: () => boolean;
}) {
  const deleteThread = useNav((s) => s.deleteThread);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(target);
  const deleted = useRef(false);
  if (target && target !== shown) setShown(target);
  const remove = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await deleteThread(target.space, target.thread.id);
      deleted.current = true;
      onDeleted(target.space, target.thread.id);
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
      <AlertDialogPopup
        className="max-w-sm"
        finalFocus={() => {
          const done = deleted.current;
          deleted.current = false;
          return done && refocus() ? false : true;
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="[overflow-wrap:anywhere]">Delete “{shown?.thread.title}”?</AlertDialogTitle>
          <AlertDialogDescription>Files it attached stay. This can’t be undone.</AlertDialogDescription>
          <FieldError>{error}</FieldError>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button size="sm" variant="outline" />}>Cancel</AlertDialogClose>
          <Button size="sm" variant="destructive" pending={busy} onClick={() => void remove()}>
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** New chat, as an icon beside the search field; pressed while the space's new chat is on show. */
function NewChatButton() {
  const space = useNav((s) => s.activeSpace);
  const newChat = useNav((s) => s.newChat);
  // A new chat that hasn't been sent yet lives here, not as a row under its space.
  const drafting = useNav((s) => !!s.activeSpace && s.open[s.activeSpace] === DRAFT && s.view === "chat" && s.settings === null);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="New chat"
            aria-pressed={drafting}
            aria-keyshortcuts={keysFor("newChat").aria}
            disabled={!space}
            onClick={() => space && void newChat(space).catch((e) => toast.error("Couldn’t start a new chat", errorText(e)))}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-pressed:bg-row-selected aria-pressed:text-foreground"
          />
        }
      >
        <Icon icon={icons.newChat} className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <span className="flex items-center gap-2">
          New chat
          <Keys keys={keysFor("newChat").keys} />
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}

const NO_SPACE_LIST: SpaceView[] = [];

/** The active space's pages (Study, Grades, Plan, Courses) as rows under the filter, the same rows as everywhere else. */
function ViewNav() {
  const space = useActiveSpace();
  const view = useNav((s) => s.view);
  const settings = useNav((s) => s.settings !== null);
  const setView = useNav((s) => s.setView);
  const retap = useNav((s) => s.retapView);
  if (!space?.educationEnabled) return null;
  return (
    <SidebarMenu aria-label="Views" className="mt-1.5">
      {VIEWS.filter((v) => v.edu).map((v) => {
        const i = VIEWS.findIndex((x) => x.id === v.id);
        const active = !settings && view === v.id;
        return (
          <SidebarMenuItem key={v.id}>
            <SidebarMenuButton
              isActive={active}
              aria-current={active ? "page" : undefined}
              aria-keyshortcuts={viewKeys(i).aria}
              onClick={() => (active ? retap(v.id as View) : setView(v.id as View))}
              className="group/view"
            >
              <Icon icon={v.icon} />
              <span className="flex-1">{v.label}</span>
              <Keys keys={viewKeys(i).keys} className="opacity-0 transition-opacity group-hover/view:opacity-100" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

export function Sidebar() {
  const spaces = useNav((s) => s.spaces);
  const active = useActiveSpace();
  const setPalette = useNav((s) => s.setPalette);
  const loadSpaces = useNav((s) => s.loadSpaces);
  const openSettings = useNav((s) => s.openSettings);
  const settingsOpen = useNav((s) => s.settings !== null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<{ space: string; thread: ThreadRow } | null>(null);
  const [text, setText] = useState("");
  const query = foldTitle(text);
  const list = spaces.data ?? NO_SPACE_LIST;
  const shown = useMemo(() => (active ? [active] : NO_SPACE_LIST), [active]);
  const ids = useMemo(() => shown.map((s) => s.id), [shown]);
  const filter = useThreadFilter(query, ids);
  const listRef = useRef<SpacesListHandle>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onDelete = useCallback((space: string, thread: ThreadRow) => setDeleting({ space, thread }), []);
  return (
    <Panel aria-label="Spaces and conversations" role="navigation">
      <SidebarRail />
      <div ref={panelRef} className="flex shrink-0 flex-col gap-1.5 px-2 pt-2">
        {list.length ? (
          <SpaceSwitcher onNewSpace={() => setCreating(true)} onDown={() => filterRef.current?.focus()} />
        ) : spaces.data ? (
          <SidebarMenuButton onClick={() => setCreating(true)}>
            <Icon icon={icons.add} />
            <span className="flex-1">New space</span>
          </SidebarMenuButton>
        ) : (
          <SidebarMenuSkeleton icon className="h-8" />
        )}
        <div className="flex items-center gap-1">
          <FilterField
            value={text}
            onChange={setText}
            busy={filter.busy}
            inputRef={filterRef}
            onDown={() => listRef.current?.focusFirst(!!query)}
            onUp={() => panelRef.current?.querySelector<HTMLElement>("button[aria-label^='Space:']")?.focus()}
            onEnter={() => (listRef.current?.hasRows() ? listRef.current.openFirst() : setPalette(true, text))}
          />
          <NewChatButton />
        </div>
        <ViewNav />
      </div>
      {spaces.loading && !spaces.data ? (
        <div className="mt-3 flex-1 px-2">
          {[0, 1, 2, 3].map((i) => (
            <SidebarMenuSkeleton key={i} index={i} icon />
          ))}
        </div>
      ) : spaces.error && !spaces.data ? (
        <div className="flex-1 px-2">
          <RowError className="h-7 px-2" message="Couldn’t load your spaces" onRetry={() => void loadSpaces()} />
        </div>
      ) : (
        // Keyed by the space: a switch brings the new space's list in fresh, its rows stepping in.
        <SpacesList key={active?.id ?? ""} ref={listRef} single spaces={shown} query={query} filter={filter} onDelete={onDelete} onExitTop={() => filterRef.current?.focus()} />
      )}
      {query ? (
        <div className="shrink-0 px-2 pb-1">
          <SidebarMenuButton tone="muted" onClick={() => setPalette(true, text)}>
            <Icon icon={icons.search} />
            <span className="min-w-0 flex-1 truncate">Search everything for “{text.trim()}”</span>
          </SidebarMenuButton>
        </div>
      ) : null}
      <UpdatePill />
      <SidebarFooter>
        <SidebarMenuButton isActive={settingsOpen} aria-keyshortcuts={keysFor("settings").aria} onClick={() => openSettings()} className="group/settings">
          <Icon icon={icons.settings} />
          <span className="flex-1">Settings</span>
          <Keys keys={keysFor("settings").keys} className="opacity-0 transition-opacity group-hover/settings:opacity-100" />
        </SidebarMenuButton>
      </SidebarFooter>
      <NewSpaceDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDeleteThread target={deleting} onClose={() => setDeleting(null)} onDeleted={filter.drop} refocus={() => listRef.current?.focusDeleted() ?? false} />
    </Panel>
  );
}
