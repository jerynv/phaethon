import { EllipsisIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar";
import { compactTime, relativeTime } from "@/lib/platform";
import { cn } from "@/lib/utils";
import type { ThreadSummary } from "./api";
import { useNav } from "./nav";
import { useShell } from "./shell-store";
import { ACTIVITY_WORDS, ActivityBadge } from "./SpaceSwitcher";
import { openConversation, UNTITLED, visibleThreads, type ThreadList } from "./threads";

/**
 * The space's conversations, newest first; the open one is marked current.
 * Each row is a button; ArrowUp/ArrowDown/Home/End move between rows,
 * ArrowRight reaches a row's menu and ArrowLeft returns, Delete asks to
 * delete it.
 */
export function ConversationList({ spaceId, list, onError }: { spaceId: string; list: ThreadList; onError(message: string): void }) {
  const view = useNav((s) => s.view);
  const activity = useNav((s) => s.activity[spaceId]);
  const setConfirmDelete = useShell((s) => s.setConfirmDelete);
  const { isMobile, setOpenMobile } = useSidebar();
  const listRef = useRef<HTMLUListElement>(null);

  if (list.threads === null && list.error) {
    return (
      <div className="flex flex-col items-start gap-2 px-2.5 py-2 text-sm" role="alert">
        <p className="text-muted-foreground">{list.error}</p>
        <Button size="xs" variant="outline" onClick={list.reload}>
          <RotateCcwIcon />
          Try again
        </Button>
      </div>
    );
  }

  if (list.threads === null) {
    return (
      <div className="flex flex-col gap-1 px-2.5 py-1" aria-hidden="true">
        {[70, 52, 84].map((w) => (
          <div key={w} className="flex h-8 items-center">
            <Skeleton className="h-3.5" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    );
  }

  const threads = visibleThreads(list.threads);
  if (threads.length === 0) {
    return <p className="px-2.5 py-1.5 text-sm text-sidebar-muted-foreground">No conversations yet.</p>;
  }

  function rows(): HTMLButtonElement[] {
    return Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-conversation-row]") ?? []);
  }

  function onKeyDown(e: KeyboardEvent<HTMLLIElement>, thread: ThreadSummary, title: string) {
    const target = e.target as HTMLElement;
    const onRow = target.hasAttribute("data-conversation-row");
    const all = rows();
    const row = target.closest("li")?.querySelector<HTMLButtonElement>("[data-conversation-row]");
    const i = row ? all.indexOf(row) : -1;
    let next: number | null = null;
    if (e.key === "ArrowDown") next = Math.min(all.length - 1, i + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, i - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = all.length - 1;
    else if (e.key === "ArrowRight" && onRow) {
      e.preventDefault();
      target.closest("li")?.querySelector<HTMLButtonElement>("[data-row-menu]")?.focus();
      return;
    } else if (e.key === "ArrowLeft" && !onRow) {
      e.preventDefault();
      row?.focus();
      return;
    } else if ((e.key === "Delete" || e.key === "Backspace") && onRow) {
      e.preventDefault();
      setConfirmDelete({ spaceId, id: thread.id, title });
      return;
    }
    if (next !== null && i !== -1) {
      e.preventDefault();
      all[next]?.focus();
    }
  }

  return (
    <SidebarMenu ref={listRef} aria-label="Conversations" className="gap-0.5">
      {threads.map((t) => {
        const title = t.messages === 0 && t.title === UNTITLED ? UNTITLED : t.title;
        const isOpen = t.current && view.kind === "chat";
        const a = t.current ? activity : undefined;
        const time = relativeTime(t.updated);
        return (
          <SidebarMenuItem key={t.id} onKeyDown={(e) => onKeyDown(e, t, title)}>
            <SidebarMenuButton
              data-conversation-row=""
              isActive={isOpen}
              aria-current={isOpen ? "page" : undefined}
              aria-label={[title, a ? ACTIVITY_WORDS[a].spoken : null, time].filter(Boolean).join(", ")}
              className="h-auto min-h-8 py-1.5 pe-2 font-normal text-sidebar-foreground data-[active=true]:font-medium"
              onClick={async () => {
                const problem = await openConversation(spaceId, t.id);
                if (problem) onError(problem);
                else if (isMobile) setOpenMobile(false);
              }}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cn("truncate", t.messages === 0 && "text-sidebar-muted-foreground")}>{title}</span>
                {a ? (
                  <ActivityBadge activity={a} className="-ms-2 mt-0.5 self-start" />
                ) : null}
              </span>
              <span
                aria-hidden="true"
                className="w-8 shrink-0 text-end text-xs text-sidebar-muted-foreground tabular-nums group-hover/menu-item:invisible group-focus-within/menu-item:invisible"
              >
                {compactTime(t.updated)}
              </span>
            </SidebarMenuButton>
            <Menu>
              <MenuTrigger
                data-row-menu=""
                tabIndex={-1}
                aria-label={`More for ${title}`}
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    className="absolute end-1 top-1 opacity-0 group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100"
                  />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end" side="bottom">
                <MenuItem variant="destructive" onClick={() => setConfirmDelete({ spaceId, id: t.id, title })}>
                  <Trash2Icon />
                  Delete…
                </MenuItem>
              </MenuPopup>
            </Menu>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
