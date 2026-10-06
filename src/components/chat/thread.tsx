import {
  ActionBarPrimitive,
  AuiIf,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  type TextMessagePartComponent,
} from "@assistant-ui/react";
import { useContext, useEffect, useRef, useState, type DragEvent } from "react";

// Built from the assistant-ui registry thread (MIT), cut down to what Phaethon's
// backend can honour and restyled with Phaethon tokens. Hidden on purpose: edit,
// regenerate, branch picker, feedback, dictation, suggestions and export. The
// backend thread is append-only, so edit and regenerate would not be true.

import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { SpaceMark } from "@/components/shell/space-mark";
import { STUB_SPACES } from "@/lib/spaces";
import { ACCESS_RECEIPT_PART, type AccessReceipt, type AgentMessageCustom } from "@/runtime/agent-adapter";

import { AccessReceiptLine, AccessRequestCard, receiptText } from "./access-request-card";
import { ApprovalCard, SpaceIdContext, focusComposer } from "./approval-card";
import { MessageAttachments } from "./attachments";
import { Composer, useAddFiles } from "./composer";
import { MessageError } from "./message-error";

const PlainText: TextMessagePartComponent = ({ text }) => <>{text}</>;
const Nothing = () => null;
const ASSISTANT_PARTS = {
  Text: MarkdownText,
  data: { by_name: { [ACCESS_RECEIPT_PART]: AccessReceiptLine } },
};

/** The card that speaks for itself while a run waits on the user, if any. */
const waitingCard = (custom: AgentMessageCustom | undefined) => custom?.approval ?? custom?.accessRequest;

/**
 * "Reading work/calendar/oct.md": activity in another space names it first.
 * Returns that space when it is one the user has and not this one.
 */
function otherSpaceIn(label: string, current: string) {
  const m = /^(?:Reading|Listing|Searching) ([^/\s]+)(?:\/|\s|$)/.exec(label);
  if (!m || m[1] === current) return undefined;
  return STUB_SPACES.find((s) => s.id === m[1]);
}

function UserMessage() {
  const hasText = useAuiState((s) => s.message.content.some((p) => p.type === "text" && p.text.trim() !== ""));
  return (
    <MessagePrimitive.Root data-role="user" className="flex flex-col items-end gap-2">
      <span className="sr-only">You said: </span>
      <MessageAttachments />
      {hasText && (
        <div className="max-w-(--ph-message-max-width) rounded-xl rounded-ee-sm bg-surface px-4 py-2.5 text-md whitespace-pre-wrap text-ink wrap-break-word">
          <MessagePrimitive.Parts components={{ Text: PlainText, File: Nothing, Image: Nothing }} />
        </div>
      )}
    </MessagePrimitive.Root>
  );
}

/**
 * What the agent is doing right now, as a quiet line under the reply:
 * "Reading file notes.md" while a tool runs, "Thinking" before the first word.
 * Spoken through ReplyAnnouncer (tool activity only), not from here.
 */
function ActivityLine() {
  // Selectors must return stable values (a fresh object each time would re-render forever).
  const toolStatus = useAuiState((s) => {
    if (s.message.status?.type !== "running") return undefined;
    const custom = s.message.metadata.custom as AgentMessageCustom | undefined;
    if (waitingCard(custom)) return undefined; // the approval or access card says it
    return custom?.toolStatus;
  });
  const spaceId = useContext(SpaceIdContext);
  const thinking = useAuiState(
    (s) =>
      s.message.status?.type === "running" &&
      !waitingCard(s.message.metadata.custom as AgentMessageCustom | undefined) &&
      !s.message.content.some((p) => p.type === "text" && p.text !== ""),
  );
  const line = toolStatus ? { text: toolStatus, tool: true } : thinking ? { text: "Thinking", tool: false } : null;
  if (!line) return null;
  const other = line.tool ? otherSpaceIn(line.text, spaceId) : undefined;
  return (
    <p className="flex min-w-0 max-w-full items-center gap-2 text-sm text-ink-secondary" data-activity>
      <span aria-hidden="true" className="relative flex size-2 shrink-0">
        <span className="absolute inset-0 animate-ping rounded-full bg-accent-fill opacity-40" />
        <span className="relative size-2 rounded-full bg-accent-fill" />
      </span>
      {line.tool && <span className="sr-only">Status: </span>}
      {other && (
        <span data-activity-space={other.id} className="contents" title={`In ${other.name}`}>
          <SpaceMark hue={other.hue} />
        </span>
      )}
      <span className="truncate">
        {line.text}
        {line.tool ? "" : "…"}
      </span>
    </p>
  );
}

function CopyReply() {
  const isLast = useAuiState((s) => s.message.isLast);
  const hasText = useAuiState((s) => s.message.content.some((p) => p.type === "text" && p.text.trim() !== ""));
  const copied = useAuiState((s) => s.message.isCopied);
  if (!hasText) return null;
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      // Older replies keep their Copy button in the tab order; it only fades until hovered or focused.
      className={
        isLast
          ? "flex gap-1"
          : "flex gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100"
      }
    >
      <ActionBarPrimitive.Copy asChild>
        <Button type="button" variant="ghost" size="xs" className="-ms-2 text-ink-secondary hover:text-ink" aria-label="Copy reply">
          <Icon name={copied ? "check" : "copy"} className="size-(--ph-icon-size-sm)" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root data-role="assistant" className="group/msg flex flex-col items-start gap-3">
      <span className="sr-only">Phaethon said: </span>
      <div className="w-full min-w-0 empty:hidden">
        <MessagePrimitive.Parts components={ASSISTANT_PARTS} />
      </div>
      <ActivityLine />
      <ApprovalCard />
      <AccessRequestCard />
      <MessageError />
      <AuiIf condition={(s) => s.message.status?.type === "incomplete" && s.message.status.reason === "cancelled"}>
        <p className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <Icon name="stop" className="size-(--ph-icon-size-sm)" />
          Reply stopped.
        </p>
      </AuiIf>
      <CopyReply />
    </MessagePrimitive.Root>
  );
}

const TOOL_ANNOUNCE_DELAY_MS = 300;

function messageText(m: { content: readonly { type: string; text?: string }[] }) {
  return m.content
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("")
    .trim();
}

/**
 * The thread's single polite live region. Streaming text is NOT spoken token by
 * token (the log has aria-live="off"); instead this announces tool activity and
 * the whole reply once it completes. Errors are announced by their role="alert".
 */
function ReplyAnnouncer() {
  const last = useAuiState((s) => s.thread.messages[s.thread.messages.length - 1]);
  const [text, setText] = useState("");
  const done = useRef<string | null>(null);
  const lastTool = useRef<string | undefined>(undefined);
  // Only a reply seen streaming here is announced; a saved one loaded with the
  // thread (after a restart or space switch) is not news.
  const streamed = useRef<string | null>(null);
  // Tool activity is spoken after a short pause: the backend sends "Waiting for
  // you to allow: ..." just before the approval itself, and that must not be
  // spoken on top of the card (which takes focus and speaks for itself).
  const pendingTool = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Access answers already spoken, so each receipt is said once.
  const saidReceipts = useRef(new Set<string>());
  const holdTool = () => {
    clearTimeout(pendingTool.current);
    pendingTool.current = undefined;
  };
  useEffect(() => holdTool, []);

  useEffect(() => {
    if (!last || last.role !== "assistant" || done.current === last.id) return;
    const status = last.status;
    if (status?.type !== "running" && streamed.current !== last.id) return;
    if (status?.type === "running") {
      streamed.current = last.id;
      const custom = last.metadata.custom as AgentMessageCustom | undefined;
      // A newly answered access request: confirm the choice once ("Allowed
      // once: Work / calendar"), since focus has just moved to the composer.
      const receipts = last.content.filter(
        (p): p is typeof p & { type: "data"; data: AccessReceipt } =>
          p.type === "data" && p.name === ACCESS_RECEIPT_PART,
      );
      const fresh = receipts.filter((p) => !saidReceipts.current.has(p.data.id));
      fresh.forEach((p) => saidReceipts.current.add(p.data.id));
      if (fresh.length) {
        holdTool();
        setText(`${receiptText(fresh[fresh.length - 1].data)}.`);
      }
      // An approval or access card takes focus and is read as an alertdialog;
      // announcing it here as well would say it twice.
      if (waitingCard(custom)) holdTool();
      else if (custom?.toolStatus && custom.toolStatus !== lastTool.current) {
        const say = custom.toolStatus;
        holdTool();
        pendingTool.current = setTimeout(() => setText(say), TOOL_ANNOUNCE_DELAY_MS);
      }
      lastTool.current = custom?.toolStatus;
      return;
    }
    holdTool();
    if (status?.type === "complete") {
      done.current = last.id;
      const reply = messageText(last);
      setText(reply ? `Phaethon replied: ${reply}` : "Phaethon finished without a reply.");
    } else if (status?.type === "incomplete" && status.reason === "cancelled") {
      done.current = last.id;
      setText("Reply stopped.");
    } else if (status?.type === "incomplete") {
      done.current = last.id; // the alert inside the message speaks for itself
    }
    lastTool.current = undefined;
  }, [last]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="reply-status">
      {text}
    </div>
  );
}

/** Shown in a space with no conversation yet: where you are and what Phaethon can see. */
function EmptyState({ spaceName }: { spaceName: string }) {
  return (
    <div className="m-auto flex max-w-(--ph-measure) flex-col items-center gap-2 px-4 py-12 text-center">
      <span
        aria-hidden="true"
        className="mb-2 flex size-10 items-center justify-center rounded-full bg-space-tint text-ink-secondary"
      >
        <Icon name="space" className="size-(--ph-icon-size-lg)" />
      </span>
      <h2 className="text-xl font-semibold text-ink">Start a conversation in {spaceName}</h2>
      <p className="max-w-md text-md text-ink-secondary">
        Phaethon can read and search the files in {spaceName}, and nothing outside it. It asks before it changes
        anything.
      </p>
    </div>
  );
}

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

export function Thread({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stopFocused = useRef(false);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const { addFiles, problems, clearProblems } = useAddFiles();
  const [dragging, setDragging] = useState(false);

  // When a reply ends while the Stop button has focus, Stop unmounts: put focus
  // back in the composer instead of dropping it to the document body.
  const wasRunning = useRef(false);
  useEffect(() => {
    const ended = wasRunning.current && !isRunning;
    wasRunning.current = isRunning;
    if (!ended) return;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (stopFocused.current || lost) focusComposer();
    stopFocused.current = false;
  }, [isRunning]);

  return (
    <SpaceIdContext.Provider value={spaceId}>
      <ThreadPrimitive.Root
        className="relative flex min-h-0 flex-1 flex-col"
        // Files can be dropped anywhere on the conversation; the + menu is the
        // single-pointer alternative (WCAG 2.5.7).
        onDragEnter={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(e) => {
          const next = e.relatedTarget as Node | null;
          if (!next || !e.currentTarget.contains(next)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(false);
          void addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <ThreadPrimitive.Viewport
          role="log"
          aria-label={`Conversation in ${spaceName}`}
          // role="log" is implicitly polite; turn that off so streaming text is not read token by token.
          aria-live="off"
          tabIndex={0}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-(--ph-thread-width) flex-1 flex-col px-6 pt-8 pb-6">
            <AuiIf condition={(s) => s.thread.isEmpty}>
              <EmptyState spaceName={spaceName} />
            </AuiIf>
            <div className="flex flex-col gap-8 empty:hidden">
              <ThreadPrimitive.Messages>
                {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
              </ThreadPrimitive.Messages>
            </div>
          </div>
          <div className="pointer-events-none sticky bottom-3 flex h-0 items-end justify-center">
            <ThreadPrimitive.ScrollToBottom asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                className="pointer-events-auto rounded-full bg-raised shadow disabled:invisible"
                aria-label="Scroll to the latest message"
                title="Scroll to the latest message"
              >
                <Icon name="arrow-down" />
              </Button>
            </ThreadPrimitive.ScrollToBottom>
          </div>
        </ThreadPrimitive.Viewport>
        <ReplyAnnouncer />
        <Composer
          spaceName={spaceName}
          inputRef={inputRef}
          stopFocused={stopFocused}
          addFiles={addFiles}
          problems={problems}
          clearProblems={clearProblems}
          dragging={dragging}
        />
        {dragging && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-3 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-focus bg-(--ph-scrim) text-ink"
          >
            <Icon name="attach" className="size-(--ph-icon-size-lg) text-accent-ink" />
            <p className="text-lg font-semibold">Drop files to attach them</p>
            <p className="text-base text-ink-secondary">Images, PDFs and text files, saved in {spaceName}</p>
          </div>
        )}
      </ThreadPrimitive.Root>
    </SpaceIdContext.Provider>
  );
}
