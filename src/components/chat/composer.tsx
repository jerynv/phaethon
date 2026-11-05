import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { DropdownMenu } from "@/components/ui/menu";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { IconTip } from "@/components/ui/tooltip";
import { addToSpace } from "@/components/shell/space-actions";
import { Icon } from "@/icons";
import { ATTACH_FILES_EVENT } from "@/lib/chat-actions";
import { cn } from "@/lib/utils";
import type { AgentMessageCustom } from "@/runtime/agent-adapter";
import {
  ACCEPT,
  MAX_FILES,
  attachmentKind,
  attachmentProblem,
  listNames,
  unsupportedProblem,
} from "@/runtime/attachments";

import { useAnnounce } from "./announce";
import { supportsEducation } from "@/lib/spaces";
import { AttachmentFold, ComposerAttachments, useAttachmentTray } from "./attachments";
import { jumpKeyLabel } from "./card-arrival";
import { VoiceInput } from "./voice-input";
import { ModelPicker } from "./model-picker";
import { TutorModePicker } from "./tutor-mode";
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
      className="mb-2 flex max-h-[25dvh] min-h-0 shrink items-start gap-2.5 overflow-y-auto rounded-lg border border-transparent bg-warning-soft py-2 ps-3 pe-1 text-base text-warning-ink"
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
        className="text-warning-ink hover:bg-transparent"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <Icon name="close" className="size-(--ph-icon-size-sm)" />
      </Button>
    </div>
  );
}

const itemClass = "flex min-h-(--ph-control-height) cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm outline-none select-none data-highlighted:bg-hover";

/**
 * The + button: attach files to this message, or add files or a folder to
 * the space itself (copied into its files/ folder, space_add.rs). Non-modal:
 * a small menu has no reason to hide the rest of the window from assistive
 * technology (a modal menu marks it aria-hidden while it stays focusable).
 */
function AddMenu({ onAttach, space }: { onAttach: () => void; space?: string }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Adding to the space: focus isn't handed back to + as the menu closes (that would
  // open its tooltip under the notice that then takes focus); back to + only when the
  // picker is cancelled, or nothing else took it.
  const adding = useRef(false);
  const add = (folder: boolean) => {
    if (!space) return;
    adding.current = true;
    void addToSpace(space, folder).then((done) => {
      if (!done || document.activeElement === document.body) triggerRef.current?.focus();
    });
  };
  return (
    <DropdownMenu.Root modal={false}>
      <IconTip label="Add to message" spoken="Attach files">
        <DropdownMenu.Trigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            round
            className="ph-add-trigger text-ink-secondary hover:text-ink data-[state=open]:text-ink"
            aria-label="Add to message"
          >
            <Icon name="plus" className="size-(--ph-icon-size)" />
          </Button>
        </DropdownMenu.Trigger>
      </IconTip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          onCloseAutoFocus={(e) => {
            if (adding.current) e.preventDefault();
            adding.current = false;
          }}
          className="z-50 min-w-[min(19rem,calc(100vw-var(--ph-space)*8))] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-1"
        >
          <DropdownMenu.Item onSelect={onAttach} className={itemClass}>
            <Icon name="attach" className="size-4 text-ink-secondary" />
            <span className="flex-1">Attach files…</span>
            <span className="text-xs text-ink-secondary">Images, PDF, text</span>
          </DropdownMenu.Item>
          {space && (
            <>
              <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line forced-colors:bg-[CanvasText]" />
              <DropdownMenu.Item onSelect={() => add(false)} className={itemClass} data-add-to-space="files">
                <Icon name="file-plus" className="size-4 text-ink-secondary" />
                <span className="flex-1">Add files to space…</span>
                <span className="text-xs text-ink-secondary">Files</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => add(true)} className={itemClass} data-add-to-space="folder">
                <Icon name="folder-plus" className="size-4 text-ink-secondary" />
                <span className="flex-1">Add folder to space…</span>
                <span className="text-xs text-ink-secondary">Folder</span>
              </DropdownMenu.Item>
            </>
          )}
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
        window.dispatchEvent(new CustomEvent("phaethon:draft-changed", { detail: spaceId }));
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
}: {
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
  const aui = useAui();
  const inputId = useId();
  const hintId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const isEmpty = useAuiState((s) => !s.composer.text.trim() && s.composer.attachments.length === 0);
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
  const tray = useAttachmentTray(inputRef);
  // Attach files… under a reply (chat-actions.tsx) opens this space's picker.
  const spaceId = pane?.spaceId;
  useEffect(() => {
    const open = (e: Event) => {
      if ((e as CustomEvent<{ space?: string }>).detail?.space === spaceId) fileInput.current?.click();
    };
    window.addEventListener(ATTACH_FILES_EVENT, open);
    return () => window.removeEventListener(ATTACH_FILES_EVENT, open);
  }, [spaceId]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Arrow Up in an empty message box edits your last message (where it can be edited); Escape
    // or Send there comes back here (the edit knows it was opened from the message box).
    if (e.key === "ArrowUp" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !isRunning && e.currentTarget.value === "") {
      const edits = pane?.rootRef.current?.querySelectorAll<HTMLElement>("[data-edit-message]");
      const last = edits?.[edits.length - 1];
      if (last) {
        e.preventDefault();
        if (pane) pane.editFromComposer.current = true;
        last.click();
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
    // Never more than about 40% of the window: what is inside (problems, files, the text) gives
    // way first, each scrolling in its own box, so the conversation always keeps the rest.
    <div className="mx-auto flex max-h-[40dvh] min-h-0 w-full max-w-(--ph-thread-width) flex-col px-(--ph-thread-gutter) pt-2 pb-4" data-composer-wrap="">
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
          // T3's ComposerSurface groups input and controls on one quiet surface.
          "flex min-h-0 flex-col gap-1 rounded-(--ph-composer-radius) border bg-raised p-2 transition-colors",
          dragging ? "border-focus bg-accent-soft" : "border-(--ph-composer-rim)",
        )}
      >
        <ComposerAttachments tray={tray} />
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
          onChange={(e) => {
            if (pane) pane.typedAt.current = Date.now();
            // Writing at the end: show the end itself (the browser stops a part-line short, inside the
            // padding), so the box shows whole lines and the line above the caret isn't sliced.
            const el = e.currentTarget;
            if (el.selectionStart === el.value.length) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
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
          // Two whole lines remain visible at rest; attachments give up space first.
          // Scrolled text is clipped at the padding, so no half line shows above or below the whole ones
          // (focus is drawn on the composer's frame, so nothing else is clipped).
          // Forced colours: the placeholder is GrayText, the system colour for hint text (not a mapped author colour).
          className="max-h-[calc(min(7lh,max(2lh,round(down,22dvh,1lh)))+var(--ph-space)*3)] min-h-[calc(2lh+var(--ph-space)*3)] w-full shrink-0 resize-none rounded-[max(0px,calc(var(--ph-composer-radius)-0.5rem))] [clip-path:inset(calc(var(--ph-space)*1.5)_0)] bg-transparent px-2 py-1.5 text-md text-ink placeholder:text-ink-secondary forced-colors:placeholder:text-[color:GrayText]"
        />
        {/* One short hint; every key is in the Shortcuts sheet. */}
        <span id={hintId} className="sr-only">
          Enter to send, Shift+Enter for a new line.
        </span>
        <div className="group/toolbar flex shrink-0 items-center gap-2">
          <AddMenu onAttach={() => fileInput.current?.click()} space={spaceId} />
          <AttachmentFold tray={tray} />
          <VoiceInput disabled={isRunning} onTranscript={(text: string) => { const before = aui.composer().getState().text; aui.composer().setText(`${before}${before && !/\s$/.test(before) ? " " : ""}${text}`); inputRef.current?.focus(); }} />
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
              "min-w-0 flex-1 truncate text-xs group-has-[[data-jump-latest]]/toolbar:hidden",
              held || waiting ? "font-medium text-ink" : "text-ink-secondary",
            )}
          >
            {held || waiting || isRunning ? hint : null}
          </p>
          <span aria-hidden="true" className="hidden flex-1 group-has-[[data-jump-latest]]/toolbar:block" />
          {pane && (
            <div className="flex min-w-0 items-center gap-0.5">
              {supportsEducation(pane.spaceId) && <TutorModePicker spaceId={pane.spaceId} spaceName={spaceName} running={isRunning} />}
              <ModelPicker spaceId={pane.spaceId} spaceName={spaceName} running={isRunning} />
            </div>
          )}
          {isRunning ? (
            <IconTip label="Stop reply" spoken="Escape">
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
                  round
                  aria-label="Stop reply"
                  data-stop=""
                  variant="destructive"
                  className="[&_.ui-button-face]:bg-danger-soft [&_.ui-button-face]:text-danger-ink"
                  onFocus={() => (stopFocused.current = true)}
                  onBlur={() => (stopFocused.current = false)}
                >
                  <Icon name="stop" className="size-3.5 fill-current stroke-none" />
                </Button>
              </ComposerPrimitive.Cancel>
            </IconTip>
          ) : (
            <IconTip label="Send message" spoken="Return">
              <ComposerPrimitive.Send asChild>
                <Button
                  type="submit"
                  size="icon"
                  variant={isEmpty ? "outline" : "default"}
                  round
                  className="disabled:text-ink-secondary disabled:opacity-100"
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
