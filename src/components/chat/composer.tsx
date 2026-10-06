import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { DropdownMenu } from "radix-ui";
import { useCallback, useId, useRef, useState, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";
import { ACCEPT, ACCEPTED_SUMMARY, MAX_FILES, attachmentProblem } from "@/runtime/attachments";

import { ComposerAttachments } from "./attachments";
import { focusComposer } from "./approval-card";

/**
 * Adds files to the message being written, after checking each one, and keeps
 * the reasons any were refused ("report.docx can't be attached...") so the
 * composer can show them. Used by the + menu, paste, and drag and drop.
 */
export function useAddFiles() {
  const aui = useAui();
  const [problems, setProblems] = useState<string[]>([]);

  const addFiles = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) return;
      const found: string[] = [];
      let count = aui.composer().getState().attachments.length;
      for (const file of files) {
        const problem = attachmentProblem(file);
        if (problem) {
          found.push(problem);
          continue;
        }
        if (count >= MAX_FILES) {
          found.push(`You can attach up to ${MAX_FILES} files to one message.`);
          break;
        }
        try {
          await aui.composer().addAttachment(file);
          count++;
        } catch (e) {
          found.push(e instanceof Error ? e.message : String(e));
        }
      }
      setProblems(found);
      focusComposer();
    },
    [aui],
  );

  return { addFiles, problems, clearProblems: () => setProblems([]) };
}

/** Why files were refused. Spoken once (role="alert"), dismissible, cleared on the next add. */
function AttachProblems({ problems, onDismiss }: { problems: string[]; onDismiss: () => void }) {
  if (problems.length === 0) return null;
  return (
    <div
      role="alert"
      className="mb-2 flex items-start gap-2.5 rounded-lg bg-warning-soft py-2 ps-3 pe-1 text-base text-warning-ink"
    >
      <Icon name="warning" className="mt-0.5" />
      <ul className="flex min-w-0 flex-1 flex-col gap-0.5">
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
        title="Dismiss"
        onClick={onDismiss}
      >
        <Icon name="close" className="size-(--st-icon-size-sm)" />
      </Button>
    </div>
  );
}

/** The + button: a small menu of things to add to the message. */
function AddMenu({ onAttach }: { onAttach: () => void }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="rounded-full text-ink-secondary hover:text-ink data-[state=open]:bg-hover data-[state=open]:text-ink"
          aria-label="Add to message"
          title="Add to message"
        >
          <Icon name="plus" className="size-(--st-icon-size-lg)" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={6}
          className="z-50 min-w-64 rounded-lg border border-line bg-raised p-1 text-ink shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-1"
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

/**
 * The message box. Keyboard: Enter sends, Shift+Enter adds a line, Escape stops
 * a running reply. Files come from the + menu, paste, or drag and drop (onto
 * the whole conversation, see Thread); the + menu is the single-pointer path.
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
  const inputId = useId();
  const hintId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const isRunning = useAuiState((s) => s.thread.isRunning);

  return (
    <div className="mx-auto w-full max-w-(--st-thread-width) px-6 pt-2 pb-4">
      <AttachProblems problems={problems} onDismiss={clearProblems} />
      <ComposerPrimitive.Root
        aria-label="Message composer"
        data-composer=""
        onSubmit={clearProblems}
        className={cn(
          "flex flex-col gap-1 rounded-(--st-composer-radius) border bg-raised p-2 shadow transition-colors",
          dragging ? "border-focus bg-accent-soft" : "border-line-strong",
        )}
      >
        <ComposerAttachments />
        <label htmlFor={inputId} className="sr-only">
          Message steward in {spaceName}
        </label>
        <ComposerPrimitive.Input
          ref={inputRef}
          id={inputId}
          data-composer-input
          aria-describedby={hintId}
          placeholder={`Message steward in ${spaceName}`}
          submitMode="enter"
          addAttachmentOnPaste={false}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length === 0) return;
            e.preventDefault();
            void addFiles(files);
          }}
          rows={1}
          className="max-h-(--st-composer-max-height) min-h-(--st-control-height-lg) w-full resize-none rounded-md bg-transparent px-2 py-1.5 text-md text-ink placeholder:text-ink-secondary"
        />
        <span id={hintId} className="sr-only">
          Press Enter to send, Shift+Enter for a new line, Escape to stop a reply.
        </span>
        <div className="flex items-center gap-2">
          <AddMenu onAttach={() => fileInput.current?.click()} />
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            data-testid="attach-input"
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files ?? []);
              e.currentTarget.value = "";
              void addFiles(files);
            }}
          />
          <p aria-hidden="true" className="flex-1 truncate text-xs text-ink-secondary">
            {isRunning ? "Esc to stop" : "Enter to send, Shift+Enter for a new line"}
          </p>
          {isRunning ? (
            <ComposerPrimitive.Cancel asChild>
              <Button
                type="button"
                size="icon-sm"
                className="rounded-full"
                aria-label="Stop reply"
                title="Stop reply"
                onFocus={() => (stopFocused.current = true)}
                onBlur={() => (stopFocused.current = false)}
              >
                <Icon name="stop" />
              </Button>
            </ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send asChild>
              <Button type="submit" size="icon-sm" className="rounded-full" aria-label="Send message" title="Send message">
                <Icon name="send" />
              </Button>
            </ComposerPrimitive.Send>
          )}
        </div>
      </ComposerPrimitive.Root>
    </div>
  );
}
