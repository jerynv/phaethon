import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { CircleStop, SendHorizontal } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { AgentMessageCustom } from "@/runtime/claude-adapter";

function UserMessage() {
  return (
    <MessagePrimitive.Root
      className="ml-auto max-w-[80%] rounded-lg bg-primary px-4 py-2 text-primary-foreground"
      data-role="user"
    >
      <span className="sr-only">You said: </span>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  );
}

/** Visible line for what the agent is doing ("Reading file notes.md"). Spoken via ReplyAnnouncer. */
function ToolStatus() {
  const status = useAuiState((s) =>
    s.message.status?.type === "running"
      ? (s.message.metadata.custom as AgentMessageCustom | undefined)?.toolStatus
      : undefined,
  );
  if (!status) return null;
  return (
    <p className="mt-1 text-sm text-muted-foreground">
      <span className="sr-only">Status: </span>
      {status}
    </p>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root
      className="mr-auto max-w-[80%] rounded-lg bg-muted px-4 py-2 text-foreground"
      data-role="assistant"
    >
      <span className="sr-only">steward said: </span>
      <div className="whitespace-pre-wrap">
        <MessagePrimitive.Parts />
      </div>
      <ToolStatus />
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="mt-2 rounded-md border-2 border-destructive bg-background px-3 py-2 text-sm text-foreground">
          <strong>Error: </strong>
          <ErrorPrimitive.Message />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
      <AuiIf condition={(s) => s.message.status?.type === "incomplete" && s.message.status.reason === "cancelled"}>
        <p className="mt-1 text-sm text-muted-foreground">Reply stopped.</p>
      </AuiIf>
      <ActionBarPrimitive.Root className="mt-1 flex gap-1">
        <ActionBarPrimitive.Copy asChild>
          <Button variant="ghost" size="xs" aria-label="Copy reply">
            Copy
          </Button>
        </ActionBarPrimitive.Copy>
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

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

  useEffect(() => {
    if (!last || last.role !== "assistant" || done.current === last.id) return;
    const status = last.status;
    if (status?.type === "running") {
      const tool = (last.metadata.custom as AgentMessageCustom | undefined)?.toolStatus;
      if (tool && tool !== lastTool.current) setText(tool);
      lastTool.current = tool;
      return;
    }
    if (status?.type === "complete") {
      done.current = last.id;
      const reply = messageText(last);
      setText(reply ? `steward replied: ${reply}` : "steward finished without a reply.");
    } else if (status?.type === "incomplete" && status.reason === "cancelled") {
      done.current = last.id;
      setText("Reply stopped.");
    } else if (status?.type === "incomplete") {
      done.current = last.id; // the alert inside the message speaks for itself
    }
    lastTool.current = undefined;
  }, [last]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {text}
    </div>
  );
}

export function Thread({ spaceName }: { spaceName: string }) {
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stopFocused = useRef(false);
  const isRunning = useAuiState((s) => s.thread.isRunning);

  // When a reply ends while the Stop button has focus, Stop unmounts: put focus
  // back in the composer instead of dropping it to the document body.
  const wasRunning = useRef(false);
  useEffect(() => {
    const ended = wasRunning.current && !isRunning;
    wasRunning.current = isRunning;
    if (!ended) return;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (stopFocused.current || lost) inputRef.current?.focus();
    stopFocused.current = false;
  }, [isRunning]);

  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport
        role="log"
        aria-label={`Conversation in ${spaceName}`}
        // role="log" is implicitly polite; turn that off so streaming text is not read token by token.
        aria-live="off"
        tabIndex={0}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
      >
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <p className="m-auto text-center text-muted-foreground">
            No messages in <strong className="text-foreground">{spaceName}</strong> yet.
          </p>
        </AuiIf>
        <ThreadPrimitive.Messages>
          {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>
      <ReplyAnnouncer />

      <ComposerPrimitive.Root
        aria-label="Message composer"
        className="flex items-end gap-2 border-t border-border p-4"
      >
        <label htmlFor={inputId} className="sr-only">
          Message steward in {spaceName}
        </label>
        <ComposerPrimitive.Input
          ref={inputRef}
          id={inputId}
          aria-describedby={hintId}
          placeholder={`Message ${spaceName}…`}
          submitMode="enter"
          rows={1}
          className="min-h-10 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-base placeholder:text-muted-foreground"
        />
        <span id={hintId} className="sr-only">
          Press Enter to send, Shift+Enter for a new line, Escape to stop a reply.
        </span>
        {isRunning ? (
          <ComposerPrimitive.Cancel asChild>
            <Button
              type="button"
              size="icon-lg"
              variant="outline"
              aria-label="Stop reply"
              onFocus={() => (stopFocused.current = true)}
              onBlur={() => (stopFocused.current = false)}
            >
              <CircleStop aria-hidden="true" />
            </Button>
          </ComposerPrimitive.Cancel>
        ) : (
          <ComposerPrimitive.Send asChild>
            <Button type="submit" size="icon-lg" aria-label="Send message">
              <SendHorizontal aria-hidden="true" />
            </Button>
          </ComposerPrimitive.Send>
        )}
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
