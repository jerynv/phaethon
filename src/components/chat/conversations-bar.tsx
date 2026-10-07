import { DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "@/icons";
import { getSettings, listThreads, newThread, openThread, type ThreadSummary } from "@/lib/backend";
import { modKeyLabel, platform } from "@/lib/platform";
import type { Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Said when a switch is asked for while a reply runs (the Rust core refuses it too). */
const BUSY = "Phaethon is still replying. Stop the reply or wait for it to finish, then try again.";

/** "Just now", "12 minutes ago", "Today at 3:12 PM", "Yesterday at 9:05 AM", "Monday", "Oct 3", "Oct 3, 2025". */
export function relativeDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const mins = Math.round((now - ms) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOf = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const days = Math.round((startOf(now) - startOf(ms)) / 86400000);
  if (days <= 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

function countText(n: number) {
  return n === 0 ? "No messages yet" : `${n} message${n === 1 ? "" : "s"}`;
}

type ListState =
  | { status: "loading" }
  | { status: "ready"; threads: ThreadSummary[]; cli: boolean }
  | { status: "error"; message: string };

/**
 * The row at the top of a space's conversation: "Conversations" (a menu of
 * this space's past conversations, the current one checked) and "New
 * conversation" (Cmd+N, Ctrl+N elsewhere).
 *
 * Keyboard: the menu is a Radix dropdown (Enter, Space or ArrowDown opens it;
 * arrows move, typing jumps by title, Enter opens one, Escape closes and
 * returns focus to the button). Switching remounts the conversation and puts
 * focus in the composer (see SpacePane); the result is said once through
 * SpacePane's status region. A switch asked for while a reply runs is refused
 * with an alert here, which clears itself once the reply ends.
 *
 * With the Claude Code backend there is no list: the CLI keeps its own history
 * and Phaethon can't reopen it, which the menu says. New conversation still
 * works there, and makes the CLI start a fresh session.
 */
export function ConversationsBar({
  space,
  running,
  onSwitched,
  shown = () => true,
}: {
  space: Space;
  /** Whether this space's pane is the one on screen (other visited spaces stay mounted, hidden). */
  shown?: () => boolean;
  /** A reply is running in this space. */
  running: boolean;
  /** The conversation changed on disk: remount it, focus the composer, say `message`. */
  onSwitched: (message: string) => void;
}) {
  const [problem, setProblem] = useState("");
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const switching = useRef(false);
  const mac = platform() === "mac";

  // The busy alert is about a reply that has now ended; anything else is cleared by the next action.
  useEffect(() => {
    if (!running) setProblem((p) => (p === BUSY ? "" : p));
  }, [running]);
  useEffect(() => {
    setProblem("");
    setOpen(false);
  }, [space.id]);

  const startNew = useCallback(async () => {
    if (working) return;
    if (running) {
      setProblem(BUSY);
      return;
    }
    setProblem("");
    setWorking(true);
    try {
      if (inTauri()) await newThread(space.id);
      onSwitched("New conversation started.");
    } catch (e) {
      setProblem(String(e));
      // Started from the menu: focus would otherwise be left on nothing.
      if (switching.current) {
        switching.current = false;
        triggerRef.current?.focus();
      }
    } finally {
      setWorking(false);
    }
  }, [running, space.id, onSwitched, working]);

  async function choose(t: ThreadSummary) {
    if (t.current) return;
    if (running) {
      setProblem(BUSY);
      return;
    }
    setProblem("");
    setWorking(true);
    // The menu closing must not pull focus back to its button: the composer
    // takes it once the conversation loads. The menu's close clears the flag.
    switching.current = true;
    try {
      await openThread(space.id, t.id);
      onSwitched(`Opened the conversation “${t.title}”.`);
    } catch (e) {
      // Refused: focus goes back to the button, next to the alert.
      switching.current = false;
      setProblem(String(e));
      triggerRef.current?.focus();
    } finally {
      setWorking(false);
    }
  }

  // Cmd+N (Ctrl+N elsewhere), unless a dialog (Settings) has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = mac ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey || e.key.toLowerCase() !== "n" || e.defaultPrevented) return;
      if (document.activeElement?.closest('[role="dialog"]')) return;
      // Only the space on screen: hidden panes of other spaces hear the key too.
      if (!shown()) return;
      e.preventDefault();
      setOpen(false);
      void startNew();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mac, startNew, shown]);

  // Fetched each time the menu opens, so it is never stale.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setList({ status: "loading" });
    if (!inTauri()) {
      setList({ status: "error", message: "Conversations are kept only in the desktop app." });
      return;
    }
    Promise.all([listThreads(space.id), getSettings()]).then(
      ([threads, settings]) => live && setList({ status: "ready", threads, cli: settings.backend === "claude-cli" }),
      (e: unknown) => live && setList({ status: "error", message: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [open, space.id]);

  // Once the list arrives, put keyboard focus on the current conversation (it
  // went to the menu itself, or to its New conversation, while loading).
  useEffect(() => {
    if (!open || list.status !== "ready") return;
    const content = contentRef.current;
    const at = document.activeElement;
    if (!content || !(at === content || at?.matches("[data-menu-new-conversation]"))) return;
    content.querySelector<HTMLElement>('[role="menuitemradio"][data-state="checked"]')?.focus();
  }, [open, list]);

  const threads = list.status === "ready" ? list.threads : [];

  return (
    <div
      data-conversations-bar=""
      // Above the pane's top fade (App's main::before), with its own fade under it so scrolled text
      // eases out below the row. No fade while the log has focus: its ring must show whole.
      className={cn(
        "relative z-20 shrink-0 bg-bg",
        "after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-4 after:bg-linear-to-b after:from-bg after:to-transparent",
        "forced-colors:after:hidden [main:has([role=log]:focus-visible)_&]:after:hidden",
      )}
    >
      {/* Padded below too, so a focused button's ring is never under the fade. */}
      <div className="flex items-center justify-end gap-1 px-2 py-1.5">
        <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
          <DropdownMenu.Trigger asChild>
            <Button ref={triggerRef} type="button" variant="ghost" size="sm" data-conversations-trigger="">
              Conversations
              <Icon name="chevron-down" className="size-(--ph-icon-size-sm)" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              ref={contentRef}
              onCloseAutoFocus={(e) => {
                if (!switching.current) return;
                switching.current = false;
                e.preventDefault();
              }}
              align="end"
              sideOffset={6}
              collisionPadding={8}
              aria-label={`Conversations in ${space.name}`}
              data-conversations-menu=""
              className={cn(
                // 22rem at the default text size, growing with it; never wider or taller than the room.
                "z-50 flex max-h-(--radix-dropdown-menu-content-available-height) w-[calc(22rem*var(--ph-ui-scale))] max-w-(--radix-dropdown-menu-content-available-width) flex-col overflow-y-auto overscroll-contain rounded-lg border border-line bg-raised p-1 text-ink shadow-lg outline-none",
                "origin-(--radix-dropdown-menu-content-transform-origin) animate-in duration-(--ph-duration-fast) fade-in-0 zoom-in-[0.97]",
                // An exit animation too: without one Radix keeps the closed menu mounted, and its
                // outside-click layer then dismisses the next open at once.
                "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]",
              )}
            >
              <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-sm font-semibold text-ink-secondary">
                Conversations in {space.name}
              </DropdownMenu.Label>
              {list.status === "loading" && (
                <p className="flex items-center gap-2 px-2.5 py-2 text-base text-ink-secondary">
                  <Icon name="spinner" className="animate-spin" />
                  Loading…
                </p>
              )}
              {list.status === "error" && (
                <p className="flex items-start gap-2 px-2.5 py-2 text-base text-ink-secondary" data-conversations-error="">
                  <Icon name="error" className="mt-0.5 shrink-0 text-danger-ink" />
                  <span className="min-w-0 wrap-anywhere">{list.message}</span>
                </p>
              )}
              {list.status === "ready" && list.cli && (
                <p className="flex items-start gap-2 px-2.5 py-2 text-base text-ink-secondary" data-conversations-cli="">
                  <Icon name="info" className="mt-0.5 shrink-0" />
                  <span className="min-w-0">
                    Claude Code keeps its own history, so past conversations can’t be reopened here. Only
                    Phaethon’s own agent keeps them. A new conversation starts Claude Code afresh.
                  </span>
                </p>
              )}
              {threads.length > 0 && (
                <DropdownMenu.RadioGroup value="current" className="flex flex-col">
                  {threads.map((t) => (
                    <DropdownMenu.RadioItem
                      key={t.id}
                      value={t.id}
                      textValue={t.title}
                      disabled={working}
                      data-thread-id={t.id}
                      onSelect={() => void choose(t)}
                      className={cn(
                        "grid cursor-default grid-cols-[var(--ph-icon-size)_minmax(0,1fr)] items-start gap-x-2 rounded-md px-2.5 py-2 outline-none select-none",
                        "data-highlighted:bg-hover data-disabled:opacity-45",
                      )}
                    >
                      {/* One line tall, so the check centres on the title at any text size. */}
                      <span className="flex h-[1lh] items-center text-base">
                        <DropdownMenu.ItemIndicator>
                          <Icon name="check" className="text-accent-ink" />
                        </DropdownMenu.ItemIndicator>
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-base font-medium">{t.title}</span>
                        <span className="text-sm text-ink-secondary">
                          {t.current ? "Current" : relativeDate(t.updated)} · {countText(t.messages)}
                        </span>
                      </span>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              )}
              {list.status === "ready" && !list.cli && threads.length <= 1 && (
                <p className="px-2.5 pt-1 pb-2 text-sm text-ink-secondary">
                  Conversations you leave with New conversation are kept here.
                </p>
              )}
              {/* Always present, so the menu has an item in every state (loading, Claude Code, an error). */}
              <DropdownMenu.Separator className="mx-1 my-1 h-px shrink-0 bg-line forced-colors:bg-[CanvasText]" />
              <DropdownMenu.Item
                data-menu-new-conversation=""
                disabled={working}
                onSelect={() => {
                  switching.current = !running;
                  void startNew();
                }}
                className={cn(
                  "flex shrink-0 cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-base font-medium outline-none select-none",
                  "data-highlighted:bg-hover data-disabled:opacity-45",
                )}
              >
                <Icon name="plus" className="text-ink-secondary" />
                <span className="flex-1">New conversation</span>
                <kbd aria-hidden="true" className="font-sans text-sm text-ink-secondary">
                  {`${modKeyLabel()}${mac ? "" : "+"}N`}
                </kbd>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-keyshortcuts={mac ? "Meta+N" : "Control+N"}
              data-new-conversation=""
              onClick={() => void startNew()}
            >
              <Icon name="plus" />
              New conversation
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            New conversation
            <kbd className="ms-2 font-sans text-ink-inverse/70">{`${modKeyLabel()}${mac ? "" : "+"}N`}</kbd>
          </TooltipContent>
        </Tooltip>
      </div>
      {problem && (
        <div className="mx-auto w-full max-w-(--ph-thread-width) px-6 pt-2">
          <div
            role="alert"
            data-conversations-problem=""
            className="flex items-start gap-2.5 rounded-lg border border-transparent bg-warning-soft py-2 ps-3 pe-1 text-base text-warning-ink"
          >
            <Icon name="warning" className="mt-0.5 shrink-0" />
            <p className="min-w-0 flex-1 wrap-anywhere">{problem}</p>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-warning-ink hover:bg-transparent hover:underline"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => setProblem("")}
            >
              <Icon name="close" className="size-(--ph-icon-size-sm)" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
