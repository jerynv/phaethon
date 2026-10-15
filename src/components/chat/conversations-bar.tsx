import { invoke } from "@tauri-apps/api/core";
import { DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { announce } from "@/components/shell/announcer";
import { Keys, spokenKeys } from "@/components/shell/command-palette";
import { modCap } from "@/components/shell/shortcuts";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "@/icons";
import {
  cliOf,
  clearThread,
  forgetThread,
  getSettings,
  listThreads,
  MEMORY_FILE,
  newThread,
  openThread,
  previewForget,
  type ForgetPreview,
  type ThreadSummary,
} from "@/lib/backend";
import { modKeyLabel, platform } from "@/lib/platform";
import type { Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { openSpaceFile } from "@/runtime/records";

/** Said when a switch is asked for while a reply runs (the Rust core refuses it too). */
const BUSY = "Phaethon is still replying. Stop the reply or wait for it to finish, then try again.";

/**
 * "Just now", "12 minutes ago", "Today at 3:12 PM", "Yesterday at 9:05 AM", "Monday", "Oct 3", "Oct 3, 2025".
 * With `withTime`, older days keep their time too ("Monday at 3:12 PM", "Oct 3 at 9:05 AM"), so two
 * versions of one conversation from the same day can be told apart.
 */
export function relativeDate(ms: number, now = Date.now(), withTime = false): string {
  const d = new Date(ms);
  const mins = Math.round((now - ms) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOf = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const days = Math.round((startOf(now) - startOf(ms)) / 86400000);
  if (days <= 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  const at = withTime ? ` at ${time}` : "";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" }) + at;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" }) + at;
}

/**
 * Delete a conversation for good (`thread_delete`): a saved one by its id, or
 * the open one ("current"), which leaves the space with an empty conversation.
 * Its files and the space's memory are left as they are: this is Clear when
 * nothing could be kept. Refused while a reply runs in the space.
 */
const deleteThread = (space: string, id: string) => invoke<void>("thread_delete", { space, id });

/**
 * Conversations Claude Code had in this space before Phaethon kept them (src-tauri/src/cli_import.rs).
 * `cli_import_offered`: whether to offer looking (Claude Code answers here, or kept transcripts for
 * this space). `cli_import_run`: brings in each one not here yet as a past conversation that resumes
 * its own session, and says their titles. Refused while a reply runs in the space.
 */
const cliImportOffered = (space: string) => invoke<boolean>("cli_import_offered", { space });
const cliImportRun = (space: string) => invoke<string[]>("cli_import_run", { space });

function countText(n: number) {
  return n === 0 ? "No messages yet" : `${n} message${n === 1 ? "" : "s"}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What Delete everything takes beside the messages, in words, from its preview (unknown until it loads). */
function forgetWhat(p: ForgetPreview | null): string {
  if (!p) return "the files attached only here and any details kept from it";
  const parts = [
    p.files > 0 ? `the ${plural(p.files, "file")} attached only here` : "",
    p.facts > 0 ? `the ${plural(p.facts, "detail")} kept from it` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" and ") : "";
}

/** The confirm's stage: asking, picking out details, or the pick failed (nothing changed). */
type ConfirmStage = { stage: "ask" } | { stage: "clearing" } | { stage: "notKept"; reason: string };

/**
 * A conversation's line under its title: "Current" or when, and how long. Edit and Regenerate
 * keep the version they replace as a saved conversation with the same title, so where titles
 * repeat each one gets its time of day, and all but the newest read "Earlier version".
 */
function stampOf(t: ThreadSummary, threads: ThreadSummary[]): string {
  const twins = threads.filter((o) => o.id !== t.id && o.title === t.title);
  const earlier = !t.current && twins.some((o) => o.updated > t.updated);
  const when = t.current ? "Current" : relativeDate(t.updated, undefined, twins.length > 0);
  return [earlier && "Earlier version", when, countText(t.messages)].filter(Boolean).join(" · ");
}

/** Stops for ArrowUp and ArrowDown: every item but the rows' own Delete (reached with ArrowRight). */
const STOPS = '[role^="menuitem"]:not([data-delete-thread]):not([data-disabled])';

type ListState =
  | { status: "loading" }
  | { status: "ready"; threads: ThreadSummary[]; cli: ReturnType<typeof cliOf>; findEarlier: boolean }
  | { status: "error"; message: string };

/**
 * The row at the top of a space's conversation: the open conversation's
 * title and date, "Conversations" (a menu of this space's conversations, the
 * current one checked, each with Delete) and "New conversation" (Cmd+N,
 * Ctrl+N elsewhere).
 *
 * Keyboard: the menu is a Radix dropdown (Enter, Space or ArrowDown opens it;
 * arrows move, typing jumps by title, Enter opens one, Escape closes and
 * returns focus to the button). ArrowUp and ArrowDown move by conversation;
 * each one's "Delete" sits beside it, reached with ArrowRight (ArrowLeft goes
 * back), and the Delete or Backspace key on a conversation does the same.
 * Delete swaps the row for an inline confirm that names the conversation and
 * says when it was last used, with two choices after Cancel (focused, the safe
 * one), each a whole target from the next: Clear keeps its key details in the
 * space's MEMORY.md (the model picks them out) and removes its messages;
 * Delete everything (red) removes its messages, the files only it uses and
 * the details kept from it. Cancel goes back to where Delete was asked from.
 * If the details can't be picked out (no model set up, offline) nothing
 * changes and the confirm offers Clear without keeping anything. A Clear
 * closes the menu and leaves a note under the bar that can show what was
 * kept and open the memory file; Delete everything on a saved conversation
 * keeps the menu open, focus moving to the row that took its place. Each is
 * announced; removing the open one starts a new conversation.
 * Switching remounts the conversation and puts focus in the composer (see
 * SpacePane); the result is said once through SpacePane's status region. A
 * switch or delete asked for while a reply runs is refused with an alert
 * here, which clears itself once the reply ends.
 *
 * A CLI’s conversations (Claude Code, Codex, Gemini CLI) are kept here the same way: each one resumes its
 * own CLI session when opened, and New conversation starts a fresh one.
 * Its confirm adds that the CLI’s own copy stays in its folder. Where Claude Code answers, or kept
 * transcripts for this space, "Find earlier Claude Code conversations" brings in those it had here
 * before Phaethon kept them (each resumes its own session); what it found is said under it.
 */
export function ConversationsBar({
  space,
  running,
  onSwitched,
  shown = () => true,
  notes,
}: {
  space: Space;
  /** Whether this space's pane is the one on screen (other visited spaces stay mounted, hidden). */
  shown?: () => boolean;
  /** A reply is running in this space. */
  running: boolean;
  /** The conversation changed on disk: remount it, focus the composer, say `message`. */
  onSwitched: (message: string) => void;
  /** Where the notes under the bar go (a refused switch, what a Clear kept), so they never change the header's height. */
  notes?: HTMLElement | null;
}) {
  const inNotes = (children: ReactNode) => (notes ? createPortal(children, notes) : children);
  const [problem, setProblem] = useState("");
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  // The open conversation, as the bar shows it; reloaded after a switch and when a reply ends.
  const [current, setCurrent] = useState<ThreadSummary | null>(null);
  const [changes, setChanges] = useState(0);
  // The conversation whose Delete is waiting for a confirm, where that confirm is, and what
  // Delete everything would take with it.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [stage, setStage] = useState<ConfirmStage>({ stage: "ask" });
  const [preview, setPreview] = useState<ForgetPreview | null>(null);
  // After a Clear: what was kept, shown under the bar until dismissed.
  const [kept, setKept] = useState<{ title: string; facts: string[] } | null>(null);
  const [showKept, setShowKept] = useState(false);
  // What the last Find earlier Claude Code conversations found, said under it until the menu closes.
  const [found, setFound] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  // Where Cancel puts focus back: the row (Delete key) or its Delete item.
  const confirmFrom = useRef<"row" | "del">("del");
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const switching = useRef(false);
  // Where focus goes in the menu after the next render.
  const focusNext = useRef<{ cancel: string } | { del: string } | { row: string } | { index: number } | null>(null);
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
    setKept(null);
  }, [space.id]);
  useEffect(() => {
    if (!open) setConfirming(null);
  }, [open]);
  // Each confirm starts by asking, and learns what Delete everything would take.
  useEffect(() => {
    setStage({ stage: "ask" });
    setPreview(null);
    if (confirming == null || !inTauri()) return;
    let live = true;
    previewForget(space.id, confirming).then(
      (p) => live && setPreview(p),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [confirming, space.id]);

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

  /**
   * Remove `t` one of three ways: "forget" (Delete everything: its messages, the files only it
   * uses, the details kept from it), "clear" (its key details kept in the space's memory first;
   * if they can't be picked out nothing changes and the confirm offers the next step) or "plain"
   * (Clear without keeping anything: only its messages). The open one is replaced by a new
   * conversation; a saved one leaves the list with focus on the row that took its place, except
   * after a Clear, which closes the menu to show what was kept under the bar.
   */
  async function remove(t: ThreadSummary, index: number, how: "forget" | "clear" | "plain") {
    if (running) {
      // Closing returns focus to the button, next to the alert.
      setProblem(BUSY);
      setOpen(false);
      return;
    }
    const id = t.current ? "current" : t.id;
    if (how !== "clear") setKept(null);
    setProblem("");
    setWorking(true);
    let said = "";
    let leftFiles = 0;
    try {
      if (how === "clear") {
        setStage({ stage: "clearing" });
        announce("Picking out what to keep…");
        const out = await clearThread(space.id, id);
        if (out.status === "notKept") {
          setStage({ stage: "notKept", reason: out.reason });
          focusNext.current = { cancel: t.id };
          announce(`Nothing was cleared: Phaethon couldn’t pick out what to keep. ${out.reason}`);
          return;
        }
        const n = out.kept.length;
        said = n
          ? `Cleared “${t.title}”. Kept ${plural(n, "detail")} in ${space.name}’s memory.`
          : `Cleared “${t.title}”. There was nothing in it to keep.`;
        setKept({ title: t.title, facts: out.kept });
        setShowKept(false);
      } else if (how === "forget") {
        const done = await forgetThread(space.id, id);
        leftFiles = done.filesLeft;
        const also = [done.files > 0 && plural(done.files, "file"), done.facts > 0 && plural(done.facts, "kept detail")].filter(Boolean);
        said = `Deleted “${t.title}”${also.length ? ` with its ${also.join(" and its ")}` : ""}.`;
      } else {
        await deleteThread(space.id, id);
        said = `Cleared “${t.title}” without keeping anything.`;
      }
      if (leftFiles > 0) setProblem(`${plural(leftFiles, "file")} attached to it couldn’t be removed from ${space.name}’s attachments folder.`);
      if (t.current) {
        switching.current = true;
        setOpen(false);
        switched(`${said} A new conversation has started.`);
        return;
      }
      setList((l) => (l.status === "ready" ? { ...l, threads: l.threads.filter((x) => x.id !== t.id) } : l));
      setConfirming(null);
      if (how === "clear") {
        // Focus goes back to Conversations, beside the note that shows what was kept.
        setOpen(false);
      } else {
        focusNext.current = { index };
      }
      announce(said);
    } catch (e) {
      switching.current = false;
      setConfirming(null);
      setProblem(String(e));
      setOpen(false);
    } finally {
      setWorking(false);
    }
  }

  /**
   * Find earlier Claude Code conversations: bring in those Claude Code had here before Phaethon kept
   * them, then show the list again with them in it. The menu stays open with focus on the item, and
   * what was found is said under it and announced.
   */
  async function findEarlier() {
    if (running) {
      setProblem(BUSY);
      setOpen(false);
      return;
    }
    setProblem("");
    setFound(null);
    setWorking(true);
    setFinding(true);
    try {
      const titles = await cliImportRun(space.id);
      const threads = await listThreads(space.id);
      setList((l) => (l.status === "ready" ? { ...l, threads } : l));
      const said = titles.length
        ? `Found ${plural(titles.length, "earlier conversation")} from Claude Code: ${titles.map((t) => `“${t}”`).join(", ")}. ${titles.length === 1 ? "It’s" : "They’re"} in the list now.`
        : "There are no earlier Claude Code conversations in this space that aren’t already here.";
      setFound(said);
      announce(said);
    } catch (e) {
      setProblem(String(e));
      setOpen(false);
    } finally {
      setWorking(false);
      setFinding(false);
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
    setFound(null);
    // The offer to look for Claude Code's earlier conversations never keeps the list from showing.
    Promise.all([listThreads(space.id), getSettings(), cliImportOffered(space.id).catch(() => false)]).then(
      ([threads, settings, findEarlier]) => live && setList({ status: "ready", threads, cli: cliOf(settings.backend), findEarlier }),
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
    if ("row" in want) return void q(`[data-thread-id="${want.row}"]`)?.focus();
    const rows = root.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    (rows[Math.min(want.index, rows.length - 1)] ?? q("[data-menu-new-conversation]"))?.focus();
  });

  // After a find the list above grows: keep what it found, and the item with focus, in view.
  useLayoutEffect(() => {
    if (!found) return;
    const root = contentRef.current;
    root?.querySelector("[data-find-earlier-result]")?.scrollIntoView({ block: "nearest" });
    root?.querySelector("[data-find-earlier]")?.scrollIntoView({ block: "nearest" });
  }, [found, list]);

  const threads = list.status === "ready" ? list.threads : [];

  function askDelete(id: string, from: "row" | "del") {
    confirmFrom.current = from;
    focusNext.current = { cancel: id };
    setConfirming(id);
  }

  // ArrowUp and ArrowDown skip the rows' Delete items; ArrowRight and ArrowLeft go between a row
  // and its Delete; Delete or Backspace on a row asks to delete it. Every other key is Radix's.
  // Run while capturing, and stopped there: Radix's items move focus on these keys themselves.
  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const root = contentRef.current;
    const el = document.activeElement;
    if (!root || !(el instanceof HTMLElement) || !root.contains(el) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const id = el.getAttribute("data-thread-id") ?? el.getAttribute("data-delete-thread");
    const onRow = el.hasAttribute("data-thread-id");
    const row = id == null ? null : root.querySelector<HTMLElement>(`[data-thread-id="${id}"]`);
    const del = id == null ? null : root.querySelector<HTMLElement>(`[data-delete-thread="${id}"]`);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // From a Delete, move as from its row.
      const stops = [...root.querySelectorAll<HTMLElement>(STOPS)];
      const at = stops.indexOf(row ?? el);
      if (at < 0) return;
      handled();
      stops[at + (e.key === "ArrowDown" ? 1 : -1)]?.focus();
    } else if (e.key === "ArrowRight" && onRow && del) {
      handled();
      del.focus();
    } else if (e.key === "ArrowLeft" && !onRow && row) {
      handled();
      row.focus();
    } else if ((e.key === "Delete" || e.key === "Backspace") && onRow && del && !working && id != null) {
      handled();
      askDelete(id, "row");
    }
  }
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
      {/* Wraps when its buttons don't fit beside the views (large text in a narrow window) instead of spilling over them;
          the title (flex-1, from nothing) gives way first. */}
      <div className="flex flex-wrap items-center justify-end gap-1 px-2 py-1.5">
        {/* Which conversation this is: its title (cut to fit, whole on hover) and when it was last used.
            No words while it is empty ("New conversation" here read as a second button beside the real one), only its room. */}
        {current && current.messages > 0 ? (
          // Title over date, each cut to fit on its own line: a long date (large text, a wide reading font)
          // can never run into the Conversations button.
          <p data-conversation-current="" className="flex min-w-0 flex-1 flex-col ps-2 text-sm leading-snug text-ink-secondary">
            <span className="min-w-0 truncate font-medium text-ink" title={current.title}>
              {current.title}
            </span>
            <span className="min-w-0 truncate text-xs">
              <span className="sr-only">, </span>
              {relativeDate(current.updated)}
            </span>
          </p>
        ) : (
          // The same two lines, empty and unseen: the bar is as tall with a title as without one, so the
          // first message (or a new conversation) never moves the conversation below.
          <p aria-hidden="true" className="invisible flex min-w-0 flex-1 flex-col ps-2 text-sm leading-snug">
            <span>{" "}</span>
            <span className="text-xs">{" "}</span>
          </p>
        )}
        <DropdownMenu.Root open={open} onOpenChange={(o) => (o || stage.stage !== "clearing") && setOpen(o)} modal={false}>
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
              onKeyDownCapture={onMenuKeyDown}
              // Escape in a delete confirm backs out of the confirm only, like Cancel; a second Escape closes the menu.
              // (Radix listens for Escape on the document, ahead of the menu's own key handler.)
              onEscapeKeyDown={(e) => {
                if (confirming == null) return;
                e.preventDefault();
                // While details are being picked out, the confirm stays: its outcome shows there.
                if (stage.stage === "clearing") return;
                focusNext.current = confirmFrom.current === "row" ? { row: confirming } : { del: confirming };
                setConfirming(null);
              }}
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
              {threads.length > 0 && (
                <DropdownMenu.RadioGroup value="current" className="flex flex-col">
                  {threads.map((t, i) => {
                    const empty = t.current && t.messages === 0;
                    const stamp = stampOf(t, threads);
                    if (confirming === t.id) {
                      // Inline confirm in place of the row: says which one (its stamp, so one of several
                      // versions can be told apart), what each choice removes and keeps, the safe choice
                      // first and focused. Clear keeps the key details in memory; Delete everything doesn't.
                      const labelId = `delete-${space.id}-${t.id}`;
                      const failed = stage.stage === "notKept" ? stage.reason : null;
                      const clearing = stage.stage === "clearing";
                      const takes = forgetWhat(preview);
                      const shared = preview?.sharedFiles ?? 0;
                      const button =
                        "flex min-h-(--ph-control-height) cursor-default items-center gap-1.5 rounded-md px-3 text-base font-medium outline-none select-none data-disabled:opacity-45";
                      return (
                        <DropdownMenu.Group
                          key={t.id}
                          aria-labelledby={labelId}
                          aria-describedby={`${labelId}-stamp`}
                          data-delete-confirm={t.id}
                          // A neutral frame (Clear is the safe choice); it stays in forced colours.
                          className="my-0.5 flex flex-col gap-2 rounded-md border border-line bg-surface-sunken px-2.5 py-2 forced-colors:border-[CanvasText]"
                        >
                          <p id={labelId} className="text-base text-ink">
                            {failed == null ? "Clear or delete “" : "Clear “"}
                            <span className="font-medium wrap-break-word">{t.title}</span>
                            {failed == null ? "”?" : "” without keeping anything?"}
                            {t.current && " A new conversation starts in its place."}
                          </p>
                          <p id={`${labelId}-stamp`} data-delete-stamp="" className="text-sm text-ink-secondary">
                            {stamp}
                          </p>
                          {failed != null ? (
                            // Said through the announcer (a menu can't hold an alert); it describes the next step.
                            <p id={`${labelId}-failed`} data-clear-failed="" className="flex items-start gap-2 text-sm text-warning-ink">
                              <Icon name="warning" className="mt-0.5 shrink-0" />
                              <span className="min-w-0 wrap-break-word">
                                Phaethon couldn’t pick out what to keep, so nothing was cleared. {failed} You can clear it
                                without keeping anything, or cancel and try again later.
                              </span>
                            </p>
                          ) : (
                            <>
                              <p id={`${labelId}-clear`} data-clear-says="" className="text-sm text-ink-secondary">
                                <span className="font-medium text-ink">Clear</span> removes the messages but keeps a few key
                                details (facts about you, decisions, deadlines) in {space.name}’s memory. Anthropic picks them out,
                                so the conversation is sent once more.
                              </p>
                              <p id={`${labelId}-forget`} data-forget-says="" className="text-sm text-ink-secondary">
                                <span className="font-medium text-danger-ink">Delete everything</span> removes the messages
                                {takes ? `, ${takes}` : ""}. Nothing is kept, and it can’t be undone.
                                {shared > 0 && ` ${plural(shared, "file")} another conversation also uses ${shared === 1 ? "stays" : "stay"}.`}
                              </p>
                            </>
                          )}
                          <p data-delete-stays="" className="text-sm text-ink-secondary">
                            {list.status === "ready" && list.cli
                              ? `What was already sent to ${list.cli.company} isn’t affected, and ${list.cli.name}’s own copy stays in its folder.`
                              : "What was already sent to Anthropic isn’t affected."}
                          </p>
                          {/* Every choice at least a whole target from the next, across and down: a slip off
                              Cancel must not remove anything. */}
                          <div className="flex flex-wrap justify-end gap-x-[max(var(--ph-target-min),calc(var(--ph-space)*8))] gap-y-[max(var(--ph-target-min),calc(var(--ph-space)*4))]">
                            <DropdownMenu.Item
                              data-delete-cancel={t.id}
                              disabled={working}
                              onSelect={(e) => {
                                e.preventDefault();
                                focusNext.current = confirmFrom.current === "row" ? { row: t.id } : { del: t.id };
                                setConfirming(null);
                              }}
                              className={cn(
                                itemClass,
                                "flex min-h-(--ph-control-height) items-center border border-line-strong bg-raised px-3 text-base font-medium data-highlighted:bg-hover",
                              )}
                            >
                              Cancel
                            </DropdownMenu.Item>
                            {failed != null ? (
                              <DropdownMenu.Item
                                data-clear-plain={t.id}
                                disabled={working}
                                aria-describedby={`${labelId}-failed`}
                                onSelect={(e) => {
                                  e.preventDefault();
                                  void remove(t, i, "plain");
                                }}
                                className={cn(button, "border-2 border-ink bg-raised text-ink data-highlighted:bg-hover")}
                              >
                                Clear without keeping anything
                              </DropdownMenu.Item>
                            ) : (
                              <>
                                <DropdownMenu.Item
                                  data-clear-button={t.id}
                                  disabled={working}
                                  aria-describedby={`${labelId}-clear`}
                                  onSelect={(e) => {
                                    e.preventDefault();
                                    void remove(t, i, "clear");
                                  }}
                                  // Neutral and solid: told from Cancel by its fill, and by a heavier border where colours are forced.
                                  className={cn(button, "bg-ink text-ink-inverse data-highlighted:bg-ink/85 forced-colors:border-2 forced-colors:border-[ButtonText]")}
                                >
                                  {clearing && <Icon name="spinner" className="shrink-0 animate-spin" />}
                                  {clearing ? "Keeping details…" : "Clear"}
                                </DropdownMenu.Item>
                                <DropdownMenu.Item
                                  data-delete-confirm-button={t.id}
                                  disabled={working}
                                  aria-describedby={`${labelId}-forget`}
                                  onSelect={(e) => {
                                    e.preventDefault();
                                    void remove(t, i, "forget");
                                  }}
                                  // An icon and a heavier border tell it apart where colours are forced.
                                  className={cn(button, "bg-danger text-ink-inverse data-highlighted:bg-danger/90 forced-colors:border-2 forced-colors:border-[ButtonText]")}
                                >
                                  <Icon name="remove" className="shrink-0" />
                                  {working && !clearing ? "Deleting…" : "Delete everything"}
                                </DropdownMenu.Item>
                              </>
                            )}
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
                          aria-keyshortcuts={empty ? undefined : "Delete"}
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
                            <span className="text-sm text-ink-secondary" data-thread-stamp="">
                              {stamp}
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
                              askDelete(t.id, "del");
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
              {list.status === "ready" && threads.length <= 1 && (
                <p className="px-2.5 pt-1 pb-2 text-sm text-ink-secondary">
                  Conversations you leave with New conversation are kept here.
                </p>
              )}
              {/* Always present, so the menu has an item in every state (loading, an error). */}
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
              {list.status === "ready" && list.findEarlier && (
                <>
                  <DropdownMenu.Item
                    data-find-earlier=""
                    disabled={working}
                    aria-describedby={found ? `found-${space.id}` : undefined}
                    onSelect={(e) => {
                      e.preventDefault();
                      void findEarlier();
                    }}
                    className={cn(itemClass, "flex shrink-0 items-center gap-2 px-2.5 py-2 text-base font-medium")}
                  >
                    <Icon name={finding ? "spinner" : "search"} className={cn("text-ink-secondary", finding && "animate-spin")} />
                    <span className="flex-1">{finding ? "Looking for earlier Claude Code conversations…" : "Find earlier Claude Code conversations"}</span>
                  </DropdownMenu.Item>
                  {/* Already announced; shown here until the menu closes. */}
                  {found && (
                    <p id={`found-${space.id}`} data-find-earlier-result="" className="px-2.5 pt-1 pb-2 text-sm wrap-break-word text-ink-secondary">
                      {found}
                    </p>
                  )}
                </>
              )}
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
      {/* Under the header, at the top of the conversation, when the pane gives them a place (in the bar otherwise). */}
      {inNotes(
        <>
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
      {kept && (
        // What the last Clear kept, until dismissed. Already announced, so not a live region.
        <div className="mx-auto w-full max-w-(--ph-thread-width) px-6 pt-2">
          <div data-kept-note="" className="flex flex-col gap-2 rounded-lg border border-line bg-surface-sunken py-2 ps-3 pe-1 text-base text-ink">
            <div className="flex items-start gap-2.5">
              <Icon name="check" className="mt-0.5 shrink-0 text-success-ink" />
              <p className="min-w-0 flex-1 wrap-break-word">
                Cleared “{kept.title}”.{" "}
                {kept.facts.length
                  ? `Kept ${plural(kept.facts.length, "detail")} in ${space.name}’s memory.`
                  : "There was nothing in it to keep."}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-ink-secondary"
                aria-label="Dismiss"
                data-kept-dismiss=""
                onClick={() => setKept(null)}
              >
                <Icon name="close" className="size-(--ph-icon-size-sm)" />
              </Button>
            </div>
            {kept.facts.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-[max(var(--ph-target-min),calc(var(--ph-space)*4))] gap-y-1 ps-[calc(var(--ph-icon-size)+var(--ph-space)*2.5)]">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="-ms-2"
                  aria-expanded={showKept}
                  aria-controls={`kept-${space.id}`}
                  data-kept-show=""
                  onClick={() => setShowKept((s) => !s)}
                >
                  <Icon name="chevron-down" className={cn("size-(--ph-icon-size-sm)", showKept && "rotate-180")} />
                  {showKept ? "Hide what was kept" : "Show what was kept"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-kept-open=""
                  onClick={() => openSpaceFile(space.id, MEMORY_FILE).catch((e: unknown) => setProblem(String(e)))}
                >
                  Open {MEMORY_FILE}
                </Button>
              </div>
            )}
            {showKept && (
              <ul id={`kept-${space.id}`} data-kept-list="" className="list-disc ps-[calc(var(--ph-icon-size)+var(--ph-space)*6)] pe-3 text-sm text-ink-secondary">
                {kept.facts.map((f, i) => (
                  <li key={i} className="wrap-break-word">
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
        </>,
      )}
    </div>
  );
}
