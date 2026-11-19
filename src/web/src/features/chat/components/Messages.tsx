import { motion } from "motion/react";
import { memo, type ReactNode, useRef, useState } from "react";
import { useNav, useOpenThread } from "@/app/store";
import { ClampedText, SurfaceError } from "@/components/errors";
import { FileChip, copyText } from "@/components/file-chip";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Step, StepList, ThoughtToggle, formatDuration } from "@/components/ui/step-list";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import { threadLoad } from "../api";
import { describeAgentError } from "../lib/agent-error";
import { replyText, segments, type AssistantMessage as Reply, type Attachment, type UserMessage as Ask } from "../lib/timeline";
import { useChats } from "../store";
import { CopyButton } from "./CodeBlock";
import { isLimit } from "./LimitCard";
import { Markdown } from "./Markdown";
import { AccessCard, ApprovalCard, QuestionCard, RecordLine } from "./PendingCards";
import { useSmoothText } from "./smooth";
import { ProgressLine, trackSpan, useNow, WorkGroup } from "./WorkGroup";

/** One formatter for every message's time (a long conversation shows hundreds). */
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
function clock(at?: number): string {
  return at ? timeFormat.format(at) : "";
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

/** A small action under a message (copy, edit, retry). */
function MessageAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost-muted" size="icon-xs" aria-label={label} onClick={onClick} />}>{children}</TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

const thumb = "overflow-hidden rounded-xl border transition-opacity hover:opacity-90";

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
        <button type="button" onClick={() => openFile(space, a.path!)} className={thumb} data-slot="file-chip" data-path={a.path}>
          <img src={a.previewUrl} alt={a.name} className="h-16 max-w-40 object-cover" />
        </button>
      );
    }
    return <FileChip space={space} path={a.path} label={a.name} className="h-7 rounded-lg px-2.5 text-sm" />;
  }
  if (a.previewUrl && a.mediaType.startsWith("image/")) {
    return (
      <>
        <button type="button" onClick={() => setPreview(true)} className={thumb}>
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
  return <FileChip space={space} path={a.name} label={a.name} onOpen={() => void resolve()} className={cn("h-7 rounded-lg px-2.5 text-sm", busy && "animate-skeleton")} />;
}

/** A message's files: shown as chips, or folded into one "5 attachments" pill when there are many (ref fd96). */
function Attachments({ list, space }: { list: Attachment[]; space: string }) {
  const [open, setOpen] = useState(false);
  const many = list.length > 3;
  return (
    <div className="flex max-w-full flex-col items-end gap-1.5">
      {many ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border bg-card px-2.5 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground"
        >
          <Icon icon={icons.attach} className="size-3.5" />
          {list.length} attachments
          <Icon icon={icons.chevronDown} className={cn("size-3.5 transition-transform duration-200", !open && "-rotate-90")} />
        </button>
      ) : null}
      {!many || open ? (
        <motion.div initial={many ? { opacity: 0, y: -4 } : false} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap justify-end gap-1.5">
          {list.map((a, i) => (
            <AttachmentChip key={`${a.name}-${i}`} a={a} space={space} />
          ))}
        </motion.div>
      ) : null}
    </div>
  );
}

/** Memoized, like `AssistantMessage`. */
export const UserMessage = memo(function UserMessage({ m, space, onEdit, canEdit }: { m: Ask; space: string; onEdit: (m: Ask) => void; canEdit: boolean }) {
  // A message sent in this window grows in from the composer; loaded ones just appear.
  const fresh = m.index === undefined;
  return (
    <MessageMenu
      items={
        <>
          <ContextMenuItem onClick={() => void copyText(m.text, "Message copied")}>
            <Icon icon={icons.copy} />
            Copy
          </ContextMenuItem>
          {canEdit ? (
            <ContextMenuItem onClick={() => onEdit(m)}>
              <Icon icon={icons.edit} />
              Edit and resend
            </ContextMenuItem>
          ) : null}
        </>
      }
    >
      <motion.div
        className="group/msg render-near-view flex origin-bottom-right flex-col items-end pb-5"
        data-role="user"
        data-turn={m.key}
        data-msg={m.key}
        initial={fresh ? { opacity: 0, y: 12, scale: 0.96 } : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", duration: 0.32, bounce: 0.18 }}
      >
        <div className="relative flex max-w-3/4 flex-col items-end gap-1.5">
          {m.attachments.length ? <Attachments list={m.attachments} space={space} /> : null}
          {m.text.trim() ? (
            <div className="max-w-full rounded-2xl bg-message px-3.5 py-2 text-base text-message-foreground">
              <ClampedText text={m.text} lines={12} />
            </div>
          ) : null}
          {/* Under the bubble, out of the flow, so a hover row never pushes the reply down. */}
          <div className="absolute top-full right-0 mt-0.5 flex h-6 items-center gap-0.5 whitespace-nowrap opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
            <span className="mr-1 type-meta">{clock(m.at)}</span>
            {canEdit ? (
              <MessageAction label="Edit and resend" onClick={() => onEdit(m)}>
                <Icon icon={icons.edit} />
              </MessageAction>
            ) : null}
            <CopyButton text={m.text} label="Copy message" />
          </div>
        </div>
      </motion.div>
    </MessageMenu>
  );
});

/** Reasoning in plain steps: one per sentence or line, the last one live while it is still being written. */
function thoughtSteps(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9“"(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A reply's reasoning (refs b583, f510, fd96): the "Thinking… / Thought 12s"
 * pill, open while it streams so the steps can be followed, folded once the
 * reply moves on. Saved conversations keep no reasoning, so this is only
 * ever seen live or just after.
 */
function Thought({ text, live, spanKey }: { text: string; live: boolean; spanKey: string }) {
  const [override, setOverride] = useState<boolean | null>(null);
  const span = trackSpan(spanKey, live);
  useNow(live);
  const open = override ?? live;
  const steps = thoughtSteps(text);
  const label = live ? "Thinking…" : span?.done ? `Thought ${formatDuration(Math.max(1000, span.ms))}` : "Thought";
  return (
    <div className="my-1.5 flex flex-col" data-slot="thought">
      <ThoughtToggle state={live ? "thinking" : "done"} label={label} open={open} onOpenChange={setOverride} />
      <StepList open={open} className="pt-2">
        {steps.map((s, i) => (
          <Step key={i} wrap state={live && i === steps.length - 1 ? "active" : "done"}>
            {s}
          </Step>
        ))}
      </StepList>
    </div>
  );
}

/** The text a reply is still writing, revealed at a steady pace. */
function StreamingText({ text, space, messageKey }: { text: string; space: string; messageKey: string }) {
  const shown = useSmoothText(text, true);
  return <Markdown text={shown} space={space} streaming messageKey={messageKey} />;
}

/** Calm inline notice when Phaethon seamlessly switched to another connected model. */
function HandoffLine({ from, to, reason }: { from: string; to: string; reason: string }) {
  const detail = reason
    ? from && !reason.toLowerCase().startsWith(from.toLowerCase())
      ? `${from} ${reason}`
      : reason
    : from
      ? `from ${from}`
      : "";
  const full = detail ? `Switched to ${to} automatically · ${detail}` : `Switched to ${to} automatically`;
  return (
    <div className="my-1.5 flex items-center" data-slot="handoff">
      <span
        title={full}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border/60 bg-well/70 px-2.5 py-1 text-muted-foreground text-xs"
      >
        <Icon icon={icons.sync} className="size-3.5 shrink-0 text-subtle-foreground" />
        <span className="min-w-0 truncate">
          Switched to <span className="font-medium text-foreground/85">{to}</span> automatically
          {detail ? <span className="text-subtle-foreground"> · {detail}</span> : null}
        </span>
      </span>
    </div>
  );
}

/** Memoized: while a reply streams, the replies above it don't render again. */
export const AssistantMessage = memo(function AssistantMessage({
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
  // An approval or access card is open: the work above it is waiting on the person, not running.
  const waiting = !!m.approval || !!m.access;
  return (
    <MessageMenu
      items={
        <>
          <ContextMenuItem disabled={!text} onClick={() => void copyText(body.current?.innerText.trim() || text, "Reply copied")}>
            <Icon icon={icons.copy} />
            Copy
          </ContextMenuItem>
          <ContextMenuItem disabled={!text} onClick={() => void copyText(text, "Copied as Markdown")}>
            <Icon icon={icons.fileCode} />
            Copy as Markdown
          </ContextMenuItem>
          {canRetry ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={onRetry}>
                <Icon icon={icons.retry} />
                Retry
              </ContextMenuItem>
            </>
          ) : null}
        </>
      }
    >
      <div className="group/msg render-near-view relative flex flex-col" data-role="assistant" data-status={m.status} data-msg={m.key}>
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
                return (
                  <WorkGroup
                    key={s.key}
                    tools={s.tools}
                    live={streaming}
                    waiting={waiting}
                    space={space}
                    spaceName={spaceName(space)}
                    spanKey={`${m.key}:${s.key}`}
                  />
                );
              case "thinking":
                return <Thought key={s.key} text={s.text} live={streaming && s === lastSeg} spanKey={`think:${m.key}:${s.key}`} />;
              case "progress":
                return (
                  <p key={s.key} className="my-0.5 flex min-h-8 items-start gap-3 py-1.5 text-muted-foreground text-sm">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                      <Icon icon={icons.reply} className="size-4" />
                    </span>
                    <span className="wrap-anywhere">{s.text}</span>
                  </p>
                );
              case "record":
                if (s.record.kind === "handoff") {
                  return <HandoffLine key={s.key} from={s.record.from} to={s.record.to} reason={s.record.reason} />;
                }
                return <RecordLine key={s.key} record={s.record} spaceName={spaceName} space={space} />;
            }
          })}
        </div>
        {streaming && segs.length === 0 && !m.toolStatus ? (
          <div className="my-1.5" role="status" aria-live="polite" data-slot="progress-line">
            <ThoughtToggle state="thinking" label="Thinking…" open={false} onOpenChange={() => {}} className="pointer-events-none" />
          </div>
        ) : null}
        {streaming && m.toolStatus && !workRunning ? <ProgressLine text={m.toolStatus} since={startedAt} waiting={waiting} /> : null}
        {m.approval ? <ApprovalCard approval={m.approval} onAnswer={(allow) => chats().approve(space, m.approval!.id, allow)} /> : null}
        {m.access ? <AccessCard access={m.access} spaceName={spaceName} onAnswer={(a) => chats().answerAccess(space, m.access!.id, a)} /> : null}
        {m.question && last ? <QuestionCard question={m.question} space={space} disabled={running} onAnswer={(a) => chats().answerLesson(space, m.question!.question.id, a)} /> : null}
        {/* The newest reply's limit errors sit over the composer (LimitCard); older ones stay where they happened. */}
        {err && m.error && !(last && isLimit(m.error.code)) ? (
          <SurfaceError
            className="my-2"
            tone={err.tone}
            title={err.title}
            message={m.error.message}
            actions={
              err.action && err.action.kind !== "retry"
                ? [{ label: err.action.label, onClick: () => openSettings("models", err.action!.kind === "agents" ? { mode: "subscription" } : undefined), primary: true }]
                : []
            }
            onRetry={err.action?.kind === "retry" && last && !running ? onRetry : undefined}
          />
        ) : null}
        {!streaming ? (
          // The newest (or a stopped) reply keeps its actions in view; older ones show them on hover, hung
          // below the reply in the gap before the next turn so they take no room of their own.
          <div
            className={cn(
              "flex h-7 items-center gap-1 transition-opacity",
              last || stopped ? "mt-1" : "absolute top-full left-0 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100",
            )}
            data-stopped={stopped || undefined}
          >
            {text ? <CopyButton text={text} label="Copy reply" /> : null}
            {canRetry && text ? (
              <Tooltip>
                <TooltipTrigger render={<Button variant="ghost-muted" size="icon-xs" aria-label="Retry" onClick={onRetry} />}>
                  <Icon icon={icons.retry} />
                </TooltipTrigger>
                <TooltipPopup>Retry</TooltipPopup>
              </Tooltip>
            ) : null}
            {stopped ? (
              <>
                <span className="ml-1 inline-flex items-center gap-1.5 text-muted-foreground text-xs">
                  <Icon icon={icons.stop} className="size-3" /> Stopped
                </span>
                {last && !running && m.index !== undefined ? (
                  <Button variant="outline" size="xs" className="ml-1" onClick={() => void chats().resume(space, m.key)}>
                    <Icon icon={icons.play} />
                    Continue
                  </Button>
                ) : null}
              </>
            ) : null}
            <span className="ml-1 type-meta opacity-0 transition-opacity group-hover/msg:opacity-100">{clock(m.at)}</span>
          </div>
        ) : null}
      </div>
    </MessageMenu>
  );
});
