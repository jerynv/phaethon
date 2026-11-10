import { FileTextIcon, PencilIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSpaceId } from "../context";
import { typeLabel } from "../lib/attachments";
import type { Attachment, UserMessage } from "../lib/timeline";
import { CopyButton } from "./CopyButton";
import { timeWords } from "./time";

function AttachmentChip({ a }: { a: Attachment }) {
  const space = useSpaceId();
  const openFile = useNav((s) => s.openFile);
  const image = a.mediaType.startsWith("image/");
  const open = a.path ? () => openFile(a.path!, space) : undefined;
  const body = (
    <>
      {image && a.previewUrl ? (
        <img src={a.previewUrl} alt="" className="size-10 shrink-0 rounded-md object-cover" />
      ) : (
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <FileTextIcon className="size-4.5" />
        </span>
      )}
      <span className="flex min-w-0 flex-col text-start">
        <span className="truncate text-sm font-medium">{a.name}</span>
        <span className="text-xs text-muted-foreground">{typeLabel(a.name, a.mediaType)}</span>
      </span>
    </>
  );
  const cls = "flex max-w-60 items-center gap-2 rounded-xl border bg-card p-1.5 pe-3";
  return open ? (
    <button type="button" onClick={open} className={cn(cls, "cursor-pointer hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring")}>
      {body}
      <span className="sr-only">, view</span>
    </button>
  ) : (
    <span className={cls}>{body}</span>
  );
}

function EditBox({ initial, onCancel, onSend }: { initial: string; onCancel: () => void; onSend: (text: string) => void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const hint = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);
  return (
    <div className="flex w-full max-w-[min(100%,36rem)] flex-col gap-2 rounded-2xl border bg-card p-2 shadow-xs focus-within:border-ring/60 focus-within:ring-[3px] focus-within:ring-ring/15">
      <textarea
        ref={ref}
        value={text}
        aria-label="Edit your message"
        aria-describedby={hint}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (text.trim()) onSend(text);
          }
        }}
        className="max-h-[40dvh] min-h-16 w-full resize-none bg-transparent px-2 py-1.5 text-[0.9375rem] leading-relaxed outline-none"
      />
      <div className="flex items-center gap-2">
        <p id={hint} className="me-auto px-2 text-xs text-muted-foreground">
          Sending replaces this and everything after it. The earlier version is kept in past conversations.
        </p>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!text.trim()} onClick={() => onSend(text)}>
          Send
        </Button>
      </div>
    </div>
  );
}

/** One of your messages: its files, its words, and (on hover or focus) when, Copy and Edit. */
export function UserRow({ message, canEdit, onEdit }: { message: UserMessage; canEdit: boolean; onEdit: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const headingId = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const stopEditing = () => {
    setEditing(false);
    requestAnimationFrame(() => editButton.current?.focus());
  };
  return (
    <article aria-labelledby={headingId} className="group/user flex flex-col items-end gap-1.5" data-role="user">
      <h2 id={headingId} className="sr-only">
        {editing ? "Editing your message" : "You said"}
      </h2>
      {message.attachments.length > 0 && (
        <div className="flex max-w-full flex-wrap justify-end gap-1.5">
          {message.attachments.map((a, i) => (
            <AttachmentChip key={`${a.name}-${i}`} a={a} />
          ))}
        </div>
      )}
      {editing ? (
        <EditBox
          initial={message.text}
          onCancel={stopEditing}
          onSend={(t) => {
            setEditing(false);
            onEdit(t);
          }}
        />
      ) : (
        message.text && (
          <div className="max-w-[min(85%,36rem)] rounded-2xl rounded-ee-md border border-transparent bg-secondary px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap text-secondary-foreground wrap-anywhere">
            {message.text}
          </div>
        )
      )}
      {!editing && (
        <div className="flex min-h-6 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/user:opacity-100 group-hover/user:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100">
          {message.at && <span className="me-1 text-xs text-muted-foreground tabular-nums">{timeWords(message.at)}</span>}
          {message.text && <CopyButton text={message.text} label="Copy message" iconOnly />}
          {canEdit && (
            <Button ref={editButton} variant="ghost-muted" size="icon-xs" aria-label="Edit your message" title="Edit" onClick={() => setEditing(true)}>
              <PencilIcon aria-hidden className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
