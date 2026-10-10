import { invoke } from "@tauri-apps/api/core";
import { DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { announce } from "@/components/shell/announcer";
import { Keys, spokenKeys } from "@/components/shell/command-palette";
import { modCap } from "@/components/shell/shortcuts";
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

/**
 * Delete a conversation for good (`thread_delete`): a saved one by its id, or
 * the open one ("current"), which leaves the space with an empty conversation.
 * Refused while a reply runs in the space.
 */
const deleteThread = (space: string, id: string) => invoke<void>("thread_delete", { space, id });

function countText(n: number) {
  return n === 0 ? "No messages yet" : `${n} message${n === 1 ? "" : "s"}`;
}

type ListState =
  | { status: "loading" }
  | { status: "ready"; threads: ThreadSummary[]; cli: boolean }
  | { status: "error"; message: string };

/**
 * The row at the top of a space's conversation: the open conversation's
 * title and date, "Conversations" (a menu of this space's conversations, the
 * current one checked, each with Delete) and "New conversation" (Cmd+N,
 * Ctrl+N elsewhere).
 *
 * Keyboard: the menu is a Radix dropdown (Enter, Space or ArrowDown opens it;
 * arrows move, typing jumps by title, Enter opens one, Escape closes and
 * returns focus to the button). Each conversation is followed by its own
 * "Delete" item; choosing it swaps the row for an inline confirm that names
 * the conversation, with focus on Cancel (the safe choice). Deleting a saved
 * conversation keeps the menu open, focus moving to the row that took its
 * place, and is announced; deleting the open one starts a new conversation.
 * Switching remounts the conversation and puts focus in the composer (see
 * SpacePane); the result is said once through SpacePane's status region. A
 * switch or delete asked for while a reply runs is refused with an alert
 * here, which clears itself once the reply ends.
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
  // The open conversation, as the bar shows it; reloaded after a switch and when a reply ends.
  const [current, setCurrent] = useState<ThreadSummary | null>(null);
  const [changes, setChanges] = useState(0);
  // The conversation whose Delete is waiting for a confirm.
  const [confirming, setConfirming] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const switching = useRef(false);
  // Where focus goes in the menu after the next render.
  const focusNext = useRef<{ cancel: string } | { del: string } | { index: number } | null>(null);
  const mac = platform() === "mac";

  const switched = useCallback(
    (message: string) => {
      setChanges((n) => n + 1);
      onSwitched(message);
    },
    [onSwitched],
  );

  // The busy alert is about a reply that has now ended; anything else is cleared by the next action.
  useEffect(() => {
    if (!running) setProblem((p) => (p === BUSY ? "" : p));
  }, [running]);
  useEffect(() => {
    setProblem("");
    setOpen(false);
  }, [space.id]);
  useEffect(() => {
    if (!open) setConfirming(null);
  }, [open]);

  // The open conversation's title and date. A reply ending can give it its first title.
  useEffect(() => {
    if (!inTauri() || running) return;
    let live = true;
    listThreads(space.id).then(
      (threads) => live && setCurrent(threads.find((t) => t.current) ?? null),
      () => live && setCurrent(null),
    );
    return () => {
      live = false;
    };
  }, [space.id, running, changes]);

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
      switched("New conversation started.");
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
  }, [running, space.id, switched, working]);

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
      switched(`Opened the conversation “${t.title}”.`);
    } catch (e) {
      // Refused: focus goes back to the button, next to the alert.
      switching.current = false;
      setProblem(String(e));
      triggerRef.current?.focus();
    } finally {
      setWorking(false);
    }
  }

  async function remove(t: ThreadSummary, index: number) {
    if (running) {
      // Closing returns focus to the button, next to the alert.
      setProblem(BUSY);
      setOpen(false);
      return;
    }
    setProblem("");
    setWorking(true);
    if (t.current) switching.current = true;
    try {
      await deleteThread(space.id, t.current ? "current" : t.id);
      if (t.current) {
        setOpen(false);
        switched(`Deleted “${t.title}”. A new conversation has started.`);
        return;
      }
      setConfirming(null);
      focusNext.current = { index };
      setList((l) => (l.status === "ready" ? { ...l, threads: l.threads.filter((x) => x.id !== t.id) } : l));
      announce(`Deleted the conversation “${t.title}”.`);
    } catch (e) {
      switching.current = false;
      setConfirming(null);
      setProblem(String(e));
      setOpen(false);
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

  // After Delete, Cancel or a delete: put focus where it belongs.
  useLayoutEffect(() => {
    const want = focusNext.current;
    const root = contentRef.current;
    if (!want || !root) return;
    focusNext.current = null;
    const q = (sel: string) => root.querySelector<HTMLElement>(sel);
    if ("cancel" in want) return void q(`[data-delete-cancel="${want.cancel}"]`)?.focus();
    if ("del" in want) return void q(`[data-delete-thread="${want.del}"]`)?.focus();
    const rows = root.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    (rows[Math.min(want.index, rows.length - 1)] ?? q("[data-menu-new-conversation]"))?.focus();
  });

  const threads = list.status === "ready" ? list.threads : [];
  const itemClass = "cursor-default rounded-md outline-none select-none data-highlighted:bg-hover data-disabled:opacity-45";

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
        {/* Which conversation this is: its title (cut to fit, whole on hover) and when it was last used. */}
        {current && (
          // Title over date, each cut to fit on its own line: a long date (large text, a wide reading font)
          // can never run into the Conversations button.
          <p data-conversation-current="" className="flex min-w-0 flex-1 flex-col ps-2 text-sm leading-snug text-ink-secondary">
            <span className="min-w-0 truncate font-medium text-ink" title={current.title}>
              {current.messages === 0 ? "New conversation" : current.title}
            </span>
            {current.messages > 0 && (
              <span className="min-w-0 truncate text-xs">
                <span className="sr-only">, </span>
                {relativeDate(current.updated)}
              </span>
            )}
          </p>
        )}
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
                  {threads.map((t, i) => {
                    const empty = t.current && t.messages === 0;
                    if (confirming === t.id) {
                      // Inline confirm in place of the row: says what goes, the safe choice first and focused.
                      const labelId = `delete-${space.id}-${t.id}`;
                      return (
                        <DropdownMenu.Group
                          key={t.id}
                          aria-labelledby={labelId}
                          data-delete-confirm={t.id}
                          className="my-0.5 flex flex-col gap-2 rounded-md bg-danger-soft px-2.5 py-2"
                        >
                          <p id={labelId} className="text-base text-ink">
                            Delete “<span className="font-medium wrap-break-word">{t.title}</span>” for good?
                            {t.current ? " A new conversation starts in its place." : " It can’t be opened again."}
                          </p>
                          {/* As far apart as Regenerate's question: a slip off Cancel must not delete for good. */}
                          <div className="flex flex-wrap justify-end gap-x-[max(var(--ph-target-min),calc(var(--ph-space)*8))] gap-y-2">
                            <DropdownMenu.Item
                              data-delete-cancel={t.id}
                              disabled={working}
                              onSelect={(e) => {
                                e.preventDefault();
                                focusNext.current = { del: t.id };
                                setConfirming(null);
                              }}
                              className={cn(
                                itemClass,
                                "flex min-h-(--ph-control-height) items-center border border-line-strong bg-raised px-3 text-base font-medium data-highlighted:bg-hover",
                              )}
                            >
                              Cancel
                            </DropdownMenu.Item>
                            <DropdownMenu.Item
                              data-delete-confirm-button={t.id}
                              disabled={working}
                              onSelect={(e) => {
                                e.preventDefault();
                                void remove(t, i);
                              }}
                              className={cn(
                                "flex min-h-(--ph-control-height) cursor-default items-center rounded-md bg-danger px-3 text-base font-medium text-ink-inverse outline-none select-none data-disabled:opacity-45",
                                "data-highlighted:bg-danger/90 forced-colors:border forced-colors:border-[ButtonText]",
                              )}
                            >
                              {working ? "Deleting…" : "Delete"}
                            </DropdownMenu.Item>
                          </div>
                        </DropdownMenu.Group>
                      );
                    }
                    return (
                      <div key={t.id} className="flex items-start gap-1">
                        <DropdownMenu.RadioItem
                          value={t.id}
                          textValue={t.title}
                          disabled={working}
                          data-thread-id={t.id}
                          onSelect={() => void choose(t)}
                          className={cn(
                            itemClass,
                            "grid min-w-0 flex-1 grid-cols-[var(--ph-icon-size)_minmax(0,1fr)] items-start gap-x-2 px-2.5 py-2",
                          )}
                        >
                          {/* One line tall, so the check centres on the title at any text size. */}
                          <span className="flex h-[1lh] items-center text-base">
                            <DropdownMenu.ItemIndicator>
                              <Icon name="check" className="text-accent-ink" />
                            </DropdownMenu.ItemIndicator>
                          </span>
                          <span className="flex min-w-0 flex-col">
                            {/* Up to two lines, so titles that start alike can be told apart in any reading font. */}
                            <span className="line-clamp-2 text-base font-medium wrap-break-word" title={t.title}>
                              {t.title}
                            </span>
                            <span className="text-sm text-ink-secondary">
                              {t.current ? "Current" : relativeDate(t.updated)} · {countText(t.messages)}
                            </span>
                          </span>
                        </DropdownMenu.RadioItem>
                        {!empty && (
                          <DropdownMenu.Item
                            data-delete-thread={t.id}
                            textValue={`Delete ${t.title}`}
                            disabled={working}
                            aria-label={`Delete “${t.title}”`}
                            onSelect={(e) => {
                              e.preventDefault();
                              focusNext.current = { cancel: t.id };
                              setConfirming(t.id);
                            }}
                            className={cn(
                              itemClass,
                              "mt-1 flex min-h-(--ph-control-height) shrink-0 items-center px-2 text-sm text-ink-secondary data-highlighted:text-danger-ink",
                            )}
                          >
                            Delete
                          </DropdownMenu.Item>
                        )}
                      </div>
                    );
                  })}
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
                className={cn(itemClass, "flex shrink-0 items-center gap-2 px-2.5 py-2 text-base font-medium")}
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
          {/* As the title bar's buttons: while it shows, Radix describes the button by the tooltip, so it gives only the shortcut, in words. */}
          <TooltipContent side="bottom" aria-label={spokenKeys([modCap(), "N"])} className="flex items-center gap-2">
            New conversation
            <Keys keys={[modCap(), "N"]} className="[&_kbd]:border-ink-inverse/30 [&_kbd]:bg-transparent [&_kbd]:text-ink-inverse/80" />
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
