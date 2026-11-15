import { BrainIcon, ChevronRightIcon, CopyIcon, CornerDownRightIcon, FileCodeIcon, PencilIcon, PlayIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useRef, useState } from "react";
import { useNav, useOpenThread } from "@/app/store";
import { ClampedText, SurfaceError } from "@/components/errors";
import { FileChip, copyText } from "@/components/file-chip";
import { toast } from "@/components/toast";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import { threadLoad } from "../api";
import { describeAgentError } from "../lib/agent-error";
import { replyText, segments, type AssistantMessage as Reply, type Attachment, type UserMessage as Ask } from "../lib/timeline";
import { useChats } from "../store";
import { CopyButton } from "./CodeBlock";
import { Markdown } from "./Markdown";
import { AccessCard, ApprovalCard, QuestionCard, RecordLine } from "./PendingCards";
import { useSmoothText } from "./smooth";
import { ProgressLine, WorkGroup } from "./WorkGroup";

function clock(at?: number): string {
  return at ? new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
}

/**
 * Right-click on a message. A right-click inside a text selection is left to
 * the system menu (Copy, Look up, spelling), so selecting and copying a few
 * words works the way it does everywhere else.
 */
function MessageMenu({ children, items }: { children: ReactNode; items: ReactNode }) {
  return (
    <div
      className="contents"
      onContextMenuCapture={(e) => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().trim() && e.currentTarget.contains(sel.anchorNode)) e.stopPropagation();
      }}
    >
      <ContextMenu>
        <ContextMenuTrigger render={<div className="contents" />}>{children}</ContextMenuTrigger>
        <ContextMenuPopup>{items}</ContextMenuPopup>
      </ContextMenu>
    </div>
  );
}

/**
 * An attachment on a sent message. Saved ones open in the viewer like any
 * file; a just-sent one has no path until the conversation is read back, so a
 * click reads it back first (the core saved it when the turn started), and a
 * just-sent image opens its preview right away.
 */
function AttachmentChip({ a, space }: { a: Attachment; space: string }) {
  const thread = useOpenThread(space);
  const openFile = useNav((s) => s.openFile);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  if (a.path) {
    if (a.previewUrl && a.mediaType.startsWith("image/")) {
      return (
        <button type="button" onClick={() => openFile(space, a.path!)} className="overflow-hidden rounded-lg border transition-opacity hover:opacity-90" data-slot="file-chip" data-path={a.path}>
          <img src={a.previewUrl} alt={a.name} className="h-16 max-w-40 object-cover" />
        </button>
      );
    }
    return <FileChip space={space} path={a.path} label={a.name} />;
  }
  if (a.previewUrl && a.mediaType.startsWith("image/")) {
    return (
      <>
        <button type="button" onClick={() => setPreview(true)} className="overflow-hidden rounded-lg border transition-opacity hover:opacity-90">
          <img src={a.previewUrl} alt={a.name} className="h-16 max-w-40 object-cover" />
        </button>
        <Dialog open={preview} onOpenChange={setPreview}>
          <DialogPopup variant="media" showCloseButton={false}>
            <DialogTitle className="sr-only">{a.name}</DialogTitle>
            <img src={a.previewUrl} alt={a.name} className="max-h-(--dialog-max-height) max-w-(--dialog-max-width) rounded-lg object-contain" />
          </DialogPopup>
        </Dialog>
      </>
    );
  }
  const resolve = async () => {
    setBusy(true);
    try {
      const saved = await threadLoad(space, thread);
      for (let i = saved.length - 1; i >= 0; i--) {
        const m = saved[i]!;
        if (m.role !== "user") continue;
        const hit = m.attachments.find((x) => x.name === a.name && x.path);
        if (hit?.path) return openFile(space, hit.path);
      }
      toast.info("Still saving that file", "It opens as soon as Phaethon has stored it, usually a moment after sending.");
    } catch (e) {
      toast.error("Couldn’t open the file", errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return <FileChip space={space} path={a.name} label={a.name} onOpen={() => void resolve()} className={cn(busy && "animate-skeleton")} />;
}

export function UserMessage({ m, space, onEdit, canEdit }: { m: Ask; space: string; onEdit: () => void; canEdit: boolean }) {
  // A message sent in this window grows in from the composer; loaded ones just appear.
  const fresh = m.index === undefined;
  return (
    <MessageMenu
      items={
        <>
          <ContextMenuItem onClick={() => void copyText(m.text, "Message copied")}>
            <CopyIcon />
            Copy
          </ContextMenuItem>
          {canEdit ? (
            <ContextMenuItem onClick={onEdit}>
              <PencilIcon />
              Edit and resend
            </ContextMenuItem>
          ) : null}
        </>
      }
    >
      <motion.div
        className="group/msg flex origin-bottom-right flex-col items-end gap-1.5"
        data-role="user"
        initial={fresh ? { opacity: 0, y: 12, scale: 0.96 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", duration: 0.32, bounce: 0.18 }}
      >
        {m.attachments.length ? (
          <div className="flex max-w-5/6 flex-wrap justify-end gap-1.5">
            {m.attachments.map((a, i) => (
              <AttachmentChip key={`${a.name}-${i}`} a={a} space={space} />
            ))}
          </div>
        ) : null}
        {m.text.trim() ? (
          <div className="max-w-5/6 rounded-xl bg-message px-3 py-2 text-base text-message-foreground">
            <ClampedText text={m.text} lines={12} />
          </div>
        ) : null}
        <div className="flex h-6 items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
          <span className="mr-1 text-2xs text-subtle-foreground tabular-nums">{clock(m.at)}</span>
          {canEdit ? (
            <Tooltip>
              <TooltipTrigger render={<button type="button" aria-label="Edit and resend" onClick={onEdit} className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" />}>
                <PencilIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>Edit and resend</TooltipPopup>
            </Tooltip>
          ) : null}
          <CopyButton text={m.text} label="Copy message" />
        </div>
      </motion.div>
    </MessageMenu>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1.5">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="-ml-1 flex h-6 items-center gap-1.5 rounded-md px-1 text-muted-foreground text-xs hover:text-foreground">
        {live ? <BrainIcon className="size-3 shrink-0" /> : <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />}
        <span className={cn(live && "text-shimmer")}>Reasoning</span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="mt-1 ml-1.5 border-l pl-3 text-muted-foreground text-xs whitespace-pre-wrap wrap-anywhere">{text}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** The text a reply is still writing, revealed at a steady pace. */
function StreamingText({ text, space, messageKey }: { text: string; space: string; messageKey: string }) {
  const shown = useSmoothText(text, true);
  return <Markdown text={shown} space={space} streaming messageKey={messageKey} />;
}

export function AssistantMessage({
  m,
  space,
  last,
  running,
  startedAt,
  spaceName,
  onRetry,
}: {
  m: Reply;
  space: string;
  last: boolean;
  running: boolean;
  startedAt?: number;
  spaceName: (id: string) => string;
  onRetry: () => void;
}) {
  const chats = useChats.getState;
  const openSettings = useNav((s) => s.openSettings);
  const body = useRef<HTMLDivElement>(null);
  const streaming = m.status === "streaming";
  const segs = segments(m.parts);
  const text = replyText(m);
  const stopped = m.status === "stopped" || m.parts.some((p) => p.type === "record" && p.record.kind === "stopped");
  const lastSeg = segs[segs.length - 1];
  const err = m.error ? describeAgentError(m.error.code, m.error.retryAfterSecs) : null;
  const canRetry = last && !running && !streaming;
  const workRunning = lastSeg?.type === "work" && lastSeg.tools.some((t) => t.status === "running");
  return (
    <MessageMenu
      items={
        <>
          <ContextMenuItem disabled={!text} onClick={() => void copyText(body.current?.innerText.trim() || text, "Reply copied")}>
            <CopyIcon />
            Copy
          </ContextMenuItem>
          <ContextMenuItem disabled={!text} onClick={() => void copyText(text, "Copied as Markdown")}>
            <FileCodeIcon />
            Copy as Markdown
          </ContextMenuItem>
          {canRetry ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onRetry}>
                <RotateCcwIcon />
                Retry
              </ContextMenuItem>
            </>
          ) : null}
        </>
      }
    >
      <div className="group/msg flex flex-col" data-role="assistant" data-status={m.status}>
        <div ref={body} className="flex flex-col">
          {segs.map((s) => {
            switch (s.type) {
              case "text":
                return streaming && s === lastSeg ? (
                  <StreamingText key={s.key} text={s.text} space={space} messageKey={m.key} />
                ) : (
                  <Markdown key={s.key} text={s.text} space={space} messageKey={m.key} />
                );
              case "work":
                return <WorkGroup key={s.key} tools={s.tools} live={streaming} space={space} spaceName={spaceName(space)} />;
              case "thinking":
                return <Thinking key={s.key} text={s.text} live={streaming && s === lastSeg} />;
              case "progress":
                return (
                  <p key={s.key} className="my-1 flex items-start gap-1.5 text-muted-foreground text-xs">
                    <CornerDownRightIcon className="mt-0.5 size-3 shrink-0" />
                    <span className="wrap-anywhere">{s.text}</span>
                  </p>
                );
              case "record":
                return <RecordLine key={s.key} record={s.record} spaceName={spaceName} />;
            }
          })}
        </div>
        {streaming && (segs.length === 0 || (m.toolStatus && !workRunning)) ? <ProgressLine text={m.toolStatus ?? "Thinking"} since={startedAt} /> : null}
        {m.approval ? <ApprovalCard approval={m.approval} onAnswer={(allow) => chats().approve(space, m.approval!.id, allow)} /> : null}
        {m.access ? <AccessCard access={m.access} spaceName={spaceName} onAnswer={(a) => chats().answerAccess(space, m.access!.id, a)} /> : null}
        {m.question && last ? <QuestionCard question={m.question} space={space} disabled={running} onAnswer={(a) => chats().answerLesson(space, m.question!.question.id, a)} /> : null}
        {err && m.error ? (
          <SurfaceError
            className="my-2"
            tone={err.tone}
            title={err.title}
            message={m.error.message}
            actions={
              err.action && err.action.kind !== "retry"
                ? [{ label: err.action.label, onClick: () => openSettings(err.action!.kind === "agents" ? "agents" : "providers"), primary: true }]
                : []
            }
            onRetry={err.action?.kind === "retry" && last && !running ? onRetry : undefined}
          />
        ) : null}
        {!streaming ? (
          <div className="flex h-7 items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 data-stopped:opacity-100" data-stopped={stopped || undefined}>
            {text ? <CopyButton text={text} label="Copy reply" /> : null}
            {stopped ? (
              <>
                <span className="ml-1 inline-flex items-center gap-1 text-2xs text-muted-foreground">
                  <SquareIcon className="size-2.5 fill-current" /> Stopped
                </span>
                {last && !running && m.index !== undefined ? (
                  <button type="button" onClick={() => void chats().resume(space, m.key)} className="ml-1 inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground text-xs hover:bg-accent hover:text-foreground">
                    <PlayIcon className="size-3" /> Continue
                  </button>
                ) : null}
              </>
            ) : null}
            <span className="ml-1 text-2xs text-subtle-foreground tabular-nums">{clock(m.at)}</span>
          </div>
        ) : null}
      </div>
    </MessageMenu>
  );
}
