import { BrainIcon, ChevronRightIcon, CornerDownRightIcon, FileIcon, FileImageIcon, FileTextIcon, PencilIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useNav } from "@/app/store";
import { ClampedText, SurfaceError } from "@/components/errors";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { describeAgentError } from "../lib/agent-error";
import { replyText, segments, type AssistantMessage as Reply, type Attachment, type UserMessage as Ask } from "../lib/timeline";
import { useChats } from "../store";
import { CopyButton } from "./CodeBlock";
import { Markdown } from "./Markdown";
import { AccessCard, ApprovalCard, QuestionCard, RecordLine } from "./PendingCards";
import { WorkGroup } from "./WorkGroup";

function clock(at?: number): string {
  return at ? new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
}

function AttachmentChip({ a, onOpen }: { a: Attachment; onOpen?: () => void }) {
  const Icon = a.mediaType.startsWith("image/") ? FileImageIcon : a.mediaType === "application/pdf" || a.mediaType.startsWith("text/") ? FileTextIcon : FileIcon;
  if (a.previewUrl && a.mediaType.startsWith("image/")) {
    return <img src={a.previewUrl} alt={a.name} className="h-16 max-w-40 rounded-lg border object-cover" />;
  }
  return (
    <button type="button" onClick={onOpen} disabled={!onOpen} className="flex h-8 max-w-56 items-center gap-2 rounded-lg border bg-background px-2 text-xs enabled:hover:bg-accent">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <MiddleTruncate value={a.name} className="min-w-0" />
    </button>
  );
}

export function UserMessage({ m, space, onEdit, canEdit }: { m: Ask; space: string; onEdit: () => void; canEdit: boolean }) {
  const openFile = useNav((s) => s.openFile);
  return (
    <div className="group/msg flex flex-col items-end gap-1.5" data-role="user">
      {m.attachments.length ? (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {m.attachments.map((a, i) => (
            <AttachmentChip key={`${a.name}-${i}`} a={a} onOpen={a.path ? () => openFile(space, a.path!) : undefined} />
          ))}
        </div>
      ) : null}
      {m.text.trim() ? (
        <div className="max-w-[85%] rounded-xl bg-message px-3 py-2 text-base text-foreground">
          <ClampedText text={m.text} lines={12} />
        </div>
      ) : null}
      <div className="flex h-6 items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
        <span className="mr-1 text-2xs text-subtle-foreground tabular-nums">{clock(m.at)}</span>
        {canEdit ? (
          <Tooltip>
            <TooltipTrigger render={<button type="button" aria-label="Edit and resend" onClick={onEdit} className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" />}>
              <PencilIcon className="size-3.5" strokeWidth={1.75} />
            </TooltipTrigger>
            <TooltipPopup>Edit and resend</TooltipPopup>
          </Tooltip>
        ) : null}
        <CopyButton text={m.text} label="Copy message" />
      </div>
    </div>
  );
}

function Elapsed({ since }: { since?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!since) return null;
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return <span className="text-subtle-foreground tabular-nums">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span>;
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1.5">
      <button type="button" onClick={() => setOpen((v) => !v)} className="-ml-1 flex h-6 items-center gap-1.5 rounded-md px-1 text-muted-foreground text-xs hover:text-foreground">
        {live ? <BrainIcon className="size-3 shrink-0" strokeWidth={2} /> : <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} strokeWidth={2.25} />}
        <span className={cn(live && "text-shimmer")}>{live ? "Reasoning" : "Reasoning"}</span>
      </button>
      {open ? <div className="mt-1 ml-1.5 border-l pl-3 text-muted-foreground text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</div> : null}
    </div>
  );
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
  const streaming = m.status === "streaming";
  const segs = segments(m.parts);
  const text = replyText(m);
  const stopped = m.status === "stopped" || m.parts.some((p) => p.type === "record" && p.record.kind === "stopped");
  const lastSeg = segs[segs.length - 1];
  const err = m.error ? describeAgentError(m.error.code, m.error.retryAfterSecs) : null;
  return (
    <div className="group/msg flex flex-col" data-role="assistant" data-status={m.status}>
      {segs.map((s) => {
        switch (s.type) {
          case "text":
            return <Markdown key={s.key} text={s.text} space={space} streaming={streaming && s === lastSeg} messageKey={m.key} />;
          case "work":
            return <WorkGroup key={s.key} tools={s.tools} live={streaming} />;
          case "thinking":
            return <Thinking key={s.key} text={s.text} live={streaming && s === lastSeg} />;
          case "progress":
            return (
              <p key={s.key} className="my-1 flex items-start gap-1.5 text-muted-foreground text-xs">
                <CornerDownRightIcon className="mt-0.5 size-3 shrink-0" strokeWidth={2} />
                <span className="[overflow-wrap:anywhere]">{s.text}</span>
              </p>
            );
          case "record":
            return <RecordLine key={s.key} record={s.record} spaceName={spaceName} />;
        }
      })}
      {streaming && (segs.length === 0 || m.toolStatus) ? (
        <div className="flex h-6 items-center gap-2 text-sm">
          <span className="text-shimmer font-medium">{m.toolStatus ?? "Thinking"}</span>
          <Elapsed since={startedAt} />
        </div>
      ) : null}
      {m.approval ? <ApprovalCard approval={m.approval} onAnswer={(allow) => chats().approve(space, m.approval!.id, allow)} /> : null}
      {m.access ? <AccessCard access={m.access} spaceName={spaceName} onAnswer={(a) => chats().answerAccess(space, m.access!.id, a)} /> : null}
      {m.question && last ? <QuestionCard question={m.question} disabled={running} onAnswer={(a) => chats().answerLesson(space, m.question!.question.id, a)} /> : null}
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
        <div className="flex h-7 items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 data-[stopped]:opacity-100" data-stopped={stopped || undefined}>
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
  );
}
