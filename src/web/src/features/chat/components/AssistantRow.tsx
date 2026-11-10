import { BrainIcon, ChevronRightIcon, MessageCircleMoreIcon, PlayIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { AccessAnswer } from "#shared/agent.ts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SettingsView } from "../api";
import { MessageContext } from "../context";
import { holdPartialCitation } from "../lib/study-cite";
import { isStopped, replyText, segments, type AssistantMessage } from "../lib/timeline";
import { AccessCard } from "./AccessCard";
import { ApprovalCard } from "./ApprovalCard";
import { CopyButton } from "./CopyButton";
import { ErrorRow } from "./ErrorRow";
import { Markdown } from "./Markdown";
import { RecordLine } from "./Records";
import { timeWords } from "./time";
import { WorkLog } from "./WorkLog";

function Thinking({ text, live }: { text: string; live: boolean }) {
  return (
    <details className="ph-block group text-sm text-muted-foreground" data-thinking="">
      <summary className="-ms-1 inline-flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md px-1 marker:content-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <BrainIcon aria-hidden className={cn("size-3.5", live && "animate-pulse motion-reduce:animate-none")} />
        {live ? "Thinking" : "Thought it through"}
        <ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
      </summary>
      <div className="mt-1 ms-1 border-s ps-3 text-sm leading-relaxed whitespace-pre-wrap">{text}</div>
    </details>
  );
}

/** What the reply is doing right now, while no words or steps say it. */
function ActivityLine({ text }: { text: string }) {
  return (
    <p className="ph-block flex min-h-7 items-center gap-2 text-sm text-muted-foreground" data-activity="">
      <span aria-hidden className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/50 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2 rounded-full bg-primary/80" />
      </span>
      <span className="truncate">{text}</span>
    </p>
  );
}

type Props = {
  message: AssistantMessage;
  question: string;
  isLast: boolean;
  running: boolean;
  space: string;
  settings: SettingsView | null;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onRetry: () => void;
  onContinue: () => void;
  onStop: () => void;
  onApprove: (id: string, allow: boolean) => Promise<string | null>;
  onAccess: (id: string, answer: AccessAnswer) => Promise<string | null>;
  announce: (t: string) => void;
};

/**
 * One reply: its words, tool work, receipts, any waiting card, an error with
 * its way out, and (once done) Copy, Regenerate or Continue.
 */
export function AssistantRow(p: Props) {
  const { message: m } = p;
  const headingId = useId();
  const streaming = m.status === "streaming";
  const segs = segments(m.parts);
  const text = replyText(m);
  const lastText = segs.map((s) => s.type).lastIndexOf("text");
  const waiting = !!(m.approval || m.access);
  const runningWork = segs.some((s) => s.type === "work" && s.tools.some((t) => t.status === "running"));
  const activity =
    streaming && !waiting
      ? m.toolStatus && !m.toolStatus.startsWith("Waiting for you") && !runningWork
        ? m.toolStatus
        : !text && !runningWork && !segs.some((s) => s.type === "thinking")
          ? "Thinking…"
          : null
      : null;
  const stopped = isStopped(m);
  const hasStopRecord = m.parts.some((x) => x.type === "record" && x.record.kind === "stopped");
  const cli = p.settings ? p.settings.backend !== "phaethon" : false;

  return (
    <article aria-labelledby={headingId} className="group/reply flex flex-col items-stretch" data-role="assistant" data-status={m.status}>
      <h2 id={headingId} className="sr-only">
        Phaethon replied
      </h2>
      <MessageContext value={{ key: m.key, streaming, question: p.question, reply: text }}>
        <div className="flex min-w-0 flex-col [&>.ph-block]:my-2 [&>.ph-block:first-child]:mt-0">
          {segs.map((s, i) => {
            switch (s.type) {
              case "text":
                return (
                  <div key={s.key} className={cn("ph-block", streaming && i === lastText && !activity && "ph-streaming")}>
                    <Markdown text={stopped && i === lastText ? holdPartialCitation(s.text) : s.text} streaming={streaming && i === lastText} />
                  </div>
                );
              case "work":
                return <WorkLog key={s.key} tools={s.tools} live={streaming && !waiting} status={streaming && i === segs.length - 1 && !m.toolStatus?.startsWith("Waiting for you") ? m.toolStatus : undefined} />;
              case "progress":
                return (
                  <p key={s.key} className="ph-block flex items-start gap-2 text-sm text-muted-foreground" data-progress="">
                    <MessageCircleMoreIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                    <span>{s.text}</span>
                  </p>
                );
              case "thinking":
                return <Thinking key={s.key} text={s.text} live={streaming && i === segs.length - 1} />;
              case "record":
                // While the question's card is open below, its record would only repeat it.
                if (s.record.kind === "check" && m.question?.question.id === s.record.id) return null;
                return <RecordLine key={s.key} record={s.record} />;
            }
          })}
          {activity && <ActivityLine text={activity} />}
          {m.approval && <ApprovalCard approval={m.approval} onAnswer={p.onApprove} announce={p.announce} />}
          {m.access && <AccessCard request={m.access} asker={p.space} onAnswer={p.onAccess} announce={p.announce} />}
          {m.error && (
            <ErrorRow
              error={m.error}
              cutOff={text !== ""}
              settings={p.settings}
              canRetry={p.isLast && !p.running}
              onRetry={p.onRetry}
              onStop={p.onStop}
            />
          )}
          {stopped && !hasStopRecord && (
            <p className="ph-block flex items-center gap-1.5 text-sm text-muted-foreground" data-record="stopped">
              <SquareIcon aria-hidden className="size-3 fill-current" />
              Reply stopped
            </p>
          )}
        </div>
      </MessageContext>
      {!streaming && (
        <ReplyActions
          text={text}
          at={m.at}
          stopped={stopped}
          failed={m.status === "failed"}
          isLast={p.isLast && !p.running}
          canRegenerate={p.canRegenerate}
          canContinue={stopped && !cli && m.index !== undefined && text !== ""}
          onRegenerate={p.onRegenerate}
          onRetry={p.onRetry}
          onContinue={p.onContinue}
          announce={p.announce}
        />
      )}
    </article>
  );
}

function ReplyActions(p: {
  text: string;
  at?: number;
  stopped: boolean;
  failed: boolean;
  isLast: boolean;
  canRegenerate: boolean;
  canContinue: boolean;
  onRegenerate: () => void;
  onRetry: () => void;
  onContinue: () => void;
  announce: (t: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  const regen = useRef<HTMLButtonElement>(null);
  const qId = useId();
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);
  const again = p.isLast && !p.failed;
  const showRegen = again && !p.stopped && p.canRegenerate;
  if (!p.text && !(again && p.stopped) && !showRegen) return null;
  const pinned = (again && p.stopped) || confirming;
  return (
    <div
      className={cn(
        "-ms-1.5 mt-1 flex min-h-7 flex-wrap items-center gap-x-1 gap-y-2",
        !pinned && "opacity-0 transition-opacity group-focus-within/reply:opacity-100 group-hover/reply:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100",
        p.isLast && "opacity-100",
      )}
      data-reply-actions=""
    >
      {p.text && <CopyButton text={p.text} label="Copy reply" done="Copied reply" onCopied={() => p.announce("Reply copied.")} />}
      {again && p.stopped && (
        <>
          {p.canContinue && (
            <Button variant="outline" size="xs" onClick={p.onContinue}>
              <PlayIcon aria-hidden />
              Continue
              <span className="sr-only"> this reply from where it stopped</span>
            </Button>
          )}
          <Button variant="outline" size="xs" onClick={p.onRetry}>
            <RotateCcwIcon aria-hidden />
            Send again
            <span className="sr-only">: answer your last message again</span>
          </Button>
        </>
      )}
      {showRegen && !confirming && (
        <Button ref={regen} variant="ghost-muted" size="xs" onClick={() => setConfirming(true)}>
          <RotateCcwIcon aria-hidden />
          Regenerate
        </Button>
      )}
      {showRegen && confirming && (
        <div
          role="group"
          aria-labelledby={qId}
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border bg-card px-3 py-1.5"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setConfirming(false);
              requestAnimationFrame(() => regen.current?.focus());
            }
          }}
        >
          <p id={qId} className="text-sm">
            Replace this reply with a new one? This one is kept in past conversations.
          </p>
          <span className="flex gap-1.5">
            <Button
              ref={keep}
              variant="outline"
              size="xs"
              onClick={() => {
                setConfirming(false);
                requestAnimationFrame(() => regen.current?.focus());
              }}
            >
              Keep this reply
            </Button>
            <Button
              size="xs"
              onClick={() => {
                setConfirming(false);
                p.onRegenerate();
              }}
            >
              Replace it
            </Button>
          </span>
        </div>
      )}
      {p.at && <span className="ms-1 text-xs text-muted-foreground tabular-nums">{timeWords(p.at)}</span>}
    </div>
  );
}
