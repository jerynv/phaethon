import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { DropdownMenu } from "radix-ui";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { IconTip } from "@/components/ui/tooltip";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";
import type { AgentMessageCustom } from "@/runtime/agent-adapter";
import {
  ACCEPT,
  ACCEPTED_SUMMARY,
  MAX_FILES,
  attachmentKind,
  attachmentProblem,
  listNames,
  unsupportedProblem,
} from "@/runtime/attachments";

import { useAnnounce } from "./announce";
import { ComposerAttachments } from "./attachments";
import { goToCard, isJumpKey, jumpKeyLabel } from "./card-arrival";
import { focusPaneComposer, usePane } from "./pane";

/**
 * Adds files to the message being written, after checking each one, and keeps
 * the reasons any were refused so the composer can show them. Files of a kind
 * Phaethon can't read are named together in one sentence, so a folder's worth
 * of them never floods the window. Used by the + menu, paste, and drag and drop.
 */
export function useAddFiles() {
  const aui = useAui();
  const pane = usePane();
  const [problems, setProblems] = useState<string[]>([]);

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      const found: string[] = [];
      const unsupported: string[] = [];
      const overLimit: string[] = [];
      let count = aui.composer().getState().attachments.length;
      for (const file of files) {
        if (!attachmentKind(file)) {
          unsupported.push(file.name);
          continue;
        }
        const problem = attachmentProblem(file);
        if (problem) {
          found.push(problem);
          continue;
        }
        if (count >= MAX_FILES) {
          overLimit.push(file.name);
          continue;
        }
        try {
          await aui.composer().addAttachment(file);
          count++;
        } catch (e) {
          found.push(e instanceof Error ? e.message : String(e));
        }
      }
      if (unsupported.length) found.unshift(unsupportedProblem(unsupported));
      // Name every file left out, so nothing is dropped silently.
      if (overLimit.length) found.push(`${listNames(overLimit)} ${overLimit.length === 1 ? "wasn’t" : "weren’t"} attached: one message can carry up to ${MAX_FILES} files.`);
      setProblems(found);
      focusPaneComposer(pane);
    },
    [aui, pane],
  );

  return { addFiles, problems, clearProblems: () => setProblems([]) };
}

/** Why files were refused. Spoken once (role="alert"), dismissible, cleared on the next add. */
function AttachProblems({ problems, onDismiss }: { problems: string[]; onDismiss: () => void }) {
  if (problems.length === 0) return null;
  return (
    <div
      role="alert"
      className="mb-2 flex max-h-[25dvh] items-start gap-2.5 overflow-y-auto rounded-lg border border-transparent bg-warning-soft py-2 ps-3 pe-1 text-base text-warning-ink"
    >
      <Icon name="warning" className="mt-0.5" />
      <ul className="flex min-w-0 flex-1 flex-col gap-0.5 wrap-anywhere">
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-warning-ink hover:bg-transparent hover:underline"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <Icon name="close" className="size-(--ph-icon-size-sm)" />
      </Button>
    </div>
  );
}

/**
 * The + button: a small menu of things to add to the message. Non-modal: a
 * one-item menu has no reason to hide the rest of the window from assistive
 * technology (a modal menu marks it aria-hidden while it stays focusable).
 */
function AddMenu({ onAttach }: { onAttach: () => void }) {
  return (
    <DropdownMenu.Root modal={false}>
      <IconTip label="Add to message" spoken="Attach files">
        <DropdownMenu.Trigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="rounded-full text-ink-secondary hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink"
            aria-label="Add to message"
          >
            <Icon name="plus" className="size-(--ph-icon-size-lg)" />
          </Button>
        </DropdownMenu.Trigger>
      </IconTip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 min-w-[min(20rem,calc(100vw-var(--ph-space)*8))] rounded-lg border border-line bg-raised p-1 text-ink shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-1"
        >
          <DropdownMenu.Item
            onSelect={onAttach}
            className="flex cursor-default items-start gap-2.5 rounded-md px-2.5 py-2 outline-none select-none data-highlighted:bg-hover"
          >
            <Icon name="attach" className="mt-0.5 text-ink-secondary" />
            <span className="flex flex-col">
              <span className="text-base font-medium">Attach files…</span>
              <span className="text-sm text-ink-secondary">{ACCEPTED_SUMMARY}</span>
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** A Stop pressed this soon after Send is taken as a bounce of the same press (C9). */
export const STOP_GUARD_MS = 800;

const draftKey = (space: string) => `phaethon:draft:${space}`;

/**
 * The message being written survives a restart: kept per space in this
 * device's storage while it is written, removed once sent. (Switching spaces
 * keeps it anyway: the pane stays mounted.)
 */
function useDraft(spaceId: string) {
  const aui = useAui();
  const text = useAuiState((s) => s.composer.text);
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    try {
      const saved = localStorage.getItem(draftKey(spaceId));
      if (saved && !aui.composer().getState().text) aui.composer().setText(saved);
    } catch {
      // Storage unavailable: drafts simply aren't kept across restarts.
    }
  }, [aui, spaceId]);
  useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      try {
        if (text.trim()) localStorage.setItem(draftKey(spaceId), text);
        else localStorage.removeItem(draftKey(spaceId));
      } catch {
        // As above.
      }
    }, 250);
    return () => clearTimeout(t);
  }, [text, spaceId]);
}

/**
 * The message box. Keyboard: Enter sends, Shift+Enter adds a line, Escape stops
 * a running reply, and Alt+Enter (Option+Return) goes to a card that waits for
 * an answer. Enter while a reply runs keeps the text and says why it wasn't
 * sent. Files come from the + menu, paste, or drag and drop (onto the whole
 * conversation, see Thread); the + menu is the single-pointer path.
 */
export function Composer({
  spaceName,
  inputRef,
  stopFocused,
  addFiles,
  problems,
  clearProblems,
  dragging,
  jump,
}: {
  /** Jump to latest (renders nothing at the bottom): it takes the hint's place in the toolbar. */
  jump?: ReactNode;
  spaceName: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  stopFocused: RefObject<boolean>;
  addFiles: (files: readonly File[]) => Promise<void>;
  problems: string[];
  clearProblems: () => void;
  dragging: boolean;
}) {
  const pane = usePane();
  const announce = useAnnounce();
  const inputId = useId();
  const hintId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const waiting = useAuiState((s) => {
    const last = s.thread.messages[s.thread.messages.length - 1];
    if (last?.status?.type !== "running") return false;
    const custom = last.metadata.custom as AgentMessageCustom | undefined;
    return !!(custom?.approval || custom?.accessRequest);
  });
  // "Still replying" after an Enter that couldn't send; cleared when the reply ends.
  const [held, setHeld] = useState(false);
  const startedAt = useRef(0);
  useEffect(() => {
    if (isRunning) startedAt.current = Date.now();
    else setHeld(false);
  }, [isRunning]);
  useDraft(pane?.spaceId ?? spaceName);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (isJumpKey(e)) {
      const card = pane?.rootRef.current?.querySelector<HTMLElement>("[data-waiting-card]");
      if (card) {
        e.preventDefault();
        goToCard(card);
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && isRunning && !e.nativeEvent.isComposing) {
      // assistant-ui would let the newline through; keep the text and say why.
      e.preventDefault();
      setHeld(true);
      announce("Still replying. Your message is kept. Press Escape to stop the reply, then send.");
    }
  }

  const hint = waiting
    ? `${jumpKeyLabel()} to answer Phaethon’s question`
    : held
      ? "Still replying. Your message is kept. Esc to stop."
      : isRunning
        ? "Esc to stop"
        : "Enter to send, Shift+Enter for a new line";

  return (
    <div className="mx-auto w-full max-w-(--ph-thread-width) px-6 pt-2 pb-4">
      <AttachProblems problems={problems} onDismiss={clearProblems} />
      <ComposerPrimitive.Root
        aria-label="Message composer"
        data-composer=""
        onSubmit={() => {
          clearProblems();
          // A message just sent is not "being typed": a card may take focus again.
          if (pane) pane.typedAt.current = 0;
        }}
        className={cn(
          // The border is ink-tertiary, at least 3:1 against the page in both themes (WCAG 1.4.11).
          "flex flex-col gap-1 rounded-(--ph-composer-radius) border bg-raised p-2 shadow transition-colors",
          dragging ? "border-focus bg-accent-soft" : "border-ink-tertiary",
        )}
      >
        <ComposerAttachments />
        <label htmlFor={inputId} className="sr-only">
          Message Phaethon in {spaceName}
        </label>
        <ComposerPrimitive.Input
          ref={inputRef}
          id={inputId}
          data-composer-input
          aria-describedby={hintId}
          placeholder={`Message Phaethon in ${spaceName}`}
          submitMode="enter"
          addAttachmentOnPaste={false}
          onKeyDown={onKeyDown}
          onChange={() => {
            if (pane) pane.typedAt.current = Date.now();
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length === 0) return;
            e.preventDefault();
            void addFiles(files);
          }}
          rows={1}
          // At most 7 whole lines, and never more than about a fifth of the window (rounded down to whole
          // lines), so a long message never pushes the conversation away; it scrolls by whole lines.
          // Forced colours: the placeholder is GrayText, the system colour for hint text (not a mapped author colour).
          className="max-h-[calc(min(7lh,max(2lh,round(down,22dvh,1lh)))+var(--ph-space)*3)] min-h-(--ph-control-height-lg) w-full resize-none rounded-md bg-transparent px-2 py-1.5 text-md text-ink placeholder:text-ink-secondary forced-colors:placeholder:text-[color:GrayText]"
        />
        <span id={hintId} className="sr-only">
          Press Enter to send, Shift+Enter for a new line, Escape to stop a reply, and {jumpKeyLabel()} to go to a
          question Phaethon is waiting on.
        </span>
        <div className="group/toolbar flex items-center gap-2">
          <AddMenu onAttach={() => fileInput.current?.click()} />
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT === "*" ? undefined : ACCEPT}
            hidden
            data-testid="attach-input"
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = "";
              void addFiles(files);
            }}
          />
          <p
            aria-hidden="true"
            data-composer-hint=""
            className={cn(
              "flex-1 truncate text-xs group-has-[[data-jump-latest]]/toolbar:hidden",
              held || waiting ? "font-medium text-ink" : "text-ink-secondary",
            )}
          >
            {hint}
          </p>
          {jump}
          <span aria-hidden="true" className="hidden flex-1 group-has-[[data-jump-latest]]/toolbar:block" />
          {isRunning ? (
            <ComposerPrimitive.Cancel
              asChild
              // A second press of Send landing on Stop (a tremor, a bouncing switch) is not a Stop.
              onClick={(e) => {
                if (Date.now() - startedAt.current < STOP_GUARD_MS) e.preventDefault();
              }}
            >
              <Button
                type="button"
                size="icon"
                className="rounded-full"
                aria-label="Stop reply"
                title="Stop reply"
                data-stop=""
                onFocus={() => (stopFocused.current = true)}
                onBlur={() => (stopFocused.current = false)}
              >
                <Icon name="stop" />
              </Button>
            </ComposerPrimitive.Cancel>
          ) : (
            <IconTip label="Send message" spoken="Return">
              <ComposerPrimitive.Send asChild>
                <Button
                  type="submit"
                  size="icon"
                  // Nothing to send yet: a quiet outlined button at full opacity, not a washed-out fill.
                  className="rounded-full disabled:border-line-strong disabled:bg-surface disabled:text-ink-secondary disabled:opacity-100 disabled:shadow-none"
                  aria-label="Send message"
                >
                  <Icon name="send" />
                </Button>
              </ComposerPrimitive.Send>
            </IconTip>
          )}
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}
