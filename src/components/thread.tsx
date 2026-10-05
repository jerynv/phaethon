import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { SendHorizontal } from "lucide-react";
import { useId } from "react";

import { Button } from "@/components/ui/button";

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

function AssistantMessage() {
  return (
    <MessagePrimitive.Root
      className="mr-auto max-w-[80%] rounded-lg bg-muted px-4 py-2 text-foreground"
      data-role="assistant"
    >
      <span className="sr-only">steward said: </span>
      <MessagePrimitive.Parts />
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

export function Thread({ spaceName }: { spaceName: string }) {
  const inputId = useId();
  const hintId = useId();

  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport
        role="log"
        aria-label={`Conversation in ${spaceName}`}
        aria-live="polite"
        aria-relevant="additions"
        tabIndex={0}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
      >
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <p className="m-auto text-center text-muted-foreground">
            No messages in <strong className="text-foreground">{spaceName}</strong> yet.
          </p>
        </AuiIf>
        <ThreadPrimitive.Messages>
          {({ message }) =>
            message.role === "user" ? <UserMessage /> : <AssistantMessage />
          }
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>

      <ComposerPrimitive.Root
        aria-label="Message composer"
        className="flex items-end gap-2 border-t border-border p-4"
      >
        <label htmlFor={inputId} className="sr-only">
          Message steward in {spaceName}
        </label>
        <ComposerPrimitive.Input
          id={inputId}
          aria-describedby={hintId}
          placeholder={`Message ${spaceName}…`}
          submitMode="enter"
          rows={1}
          className="min-h-10 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-base placeholder:text-muted-foreground"
        />
        <span id={hintId} className="sr-only">
          Press Enter to send, Shift+Enter for a new line.
        </span>
        <ComposerPrimitive.Send asChild>
          <Button type="submit" size="icon-lg" aria-label="Send message">
            <SendHorizontal aria-hidden="true" />
          </Button>
        </ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
    </ThreadPrimitive.Root>
  );
}
