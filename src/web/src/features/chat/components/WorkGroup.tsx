import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { ToolCategory } from "#shared/agent.ts";
import { FileChip } from "@/components/file-chip";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { Spinner } from "@/components/ui/spinner";
import { Step, StepList, ToolSummary, formatDuration } from "@/components/ui/step-list";
import { usePrefs } from "@/features/settings/prefs";
import { cn } from "@/lib/utils";
import { elapsedText, friendlyStep, patienceHint } from "../lib/progress";
import { workSummary, type ToolRecord } from "../lib/timeline";
import { CopyButton } from "./CodeBlock";

/** One glyph per kind of step, readable without knowing what a tool is (docs/UI-REBUILD.md › Icons). */
const ICON: Record<ToolCategory, IconData> = {
  read: icons.read,
  list: icons.list,
  search: icons.search,
  command: icons.terminal,
  write: icons.write,
  other: icons.step,
};

/** The grey chip on a step's right ("file", "search"), after the references' "script · file" tags. */
const TAG: Record<ToolCategory, string | null> = {
  read: "file",
  write: "edit",
  list: "folder",
  search: "search",
  command: "command",
  other: null,
};

/**
 * When something was first and last seen running in this window, so a step,
 * a work group or a reasoning block can say how long it took ("Thought 12s",
 * "6m 12s"). Saved conversations carry no timings, so those show none.
 */
const spans = new Map<string, { start: number; end?: number }>();
export function trackSpan(id: string, active: boolean): { ms: number; done: boolean } | null {
  let s = spans.get(id);
  if (!s) {
    if (!active) return null;
    s = { start: Date.now() };
    spans.set(id, s);
    if (spans.size > 500) spans.delete(spans.keys().next().value!);
  }
  if (!active && s.end === undefined) s.end = Date.now();
  if (active) s.end = undefined;
  return { ms: (s.end ?? Date.now()) - s.start, done: s.end !== undefined };
}

export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** A reassuring second line under a long step; grows in and out. */
function Patience({ hint, className }: { hint: string | null; className?: string }) {
  return (
    <AnimatePresence initial={false}>
      {hint ? (
        <motion.span
          key={hint}
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.18 }}
          className={cn("block text-muted-foreground text-sm", className)}
        >
          {hint}
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * The live line under a reply while Phaethon works on something that isn't a
 * tool step (waiting for an answer, starting up): the spinner arc, what it is
 * doing in plain words with a shimmer, and how long it has taken. The words
 * cross-fade when they change.
 */
export function ProgressLine({ text, since, category, technical }: { text: string; since?: number; category?: ToolCategory; technical?: string }) {
  const now = useNow(true);
  const ms = since ? now - since : 0;
  return (
    <div className="my-1 flex flex-col" role="status" aria-live="polite" data-slot="progress-line">
      <div className="flex h-9 min-w-0 items-center gap-3 text-base">
        <span className="flex w-5 shrink-0 justify-center">
          <Spinner size="md" className="text-muted-foreground" />
        </span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={text}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="min-w-0 truncate text-shimmer"
          >
            {text}…
          </motion.span>
        </AnimatePresence>
        {technical ? <span className="min-w-0 truncate font-mono text-subtle-foreground text-xs">{technical}</span> : null}
        {since ? <span className="ml-auto shrink-0 text-muted-foreground text-sm tabular-nums">{elapsedText(ms)}</span> : null}
      </div>
      <Patience hint={patienceHint(ms, category)} className="pl-8" />
    </div>
  );
}

function stepState(t: ToolRecord) {
  if (t.status === "running") return "active" as const;
  if (t.status === "failed") return "failed" as const;
  if (t.status === "success") return "done" as const;
  return "pending" as const;
}

/** What a step says: plain words, or the tool's own label with Settings › Show technical details. */
function stepLabel(t: ToolRecord, technical: boolean, spaceName?: string): string {
  if (technical) return t.label;
  const isFile = !!t.target && (t.category === "read" || t.category === "write");
  if (!isFile) return friendlyStep(t, spaceName);
  if (t.category === "read") return t.status === "running" ? "Reading" : "Read";
  return t.status === "running" ? "Writing" : "Wrote";
}

/** A tool's output, with Show technical details: a code-like block with a copy button (ref 7cad). */
function StepDetail({ text }: { text: string }) {
  return (
    <div className="group/detail relative mt-1 mb-1 rounded-xl border bg-code px-4 py-3">
      <p className="line-clamp-3 pr-8 font-mono text-muted-foreground text-xs wrap-anywhere">{text}</p>
      <CopyButton text={text} label="Copy output" className="absolute top-2 right-2" />
    </div>
  );
}

/**
 * Consecutive tool steps (refs 7cad, 95ba). One summary line ("Read 3 files,
 * searched twice … 4s") that opens to the steps on a rail, a glyph and a tag
 * per step, each file a chip that opens it. While a step runs the line says
 * what it is doing in plain words, with a shimmer, the elapsed time and after
 * a while a reassuring second line. Tool labels, raw paths and output appear
 * only with Settings › General › Show technical details.
 */
export function WorkGroup({ tools, live, space, spaceName, spanKey }: { tools: ToolRecord[]; live: boolean; space: string; spaceName?: string; spanKey?: string }) {
  const technical = usePrefs((s) => s.technicalDetails);
  const running = live ? tools.find((t) => t.status === "running") : undefined;
  const [open, setOpen] = useState(false);
  const span = trackSpan(`work:${spanKey ?? tools[0]?.id ?? ""}`, !!running);
  useNow(!!running);
  const stepSpan = running ? trackSpan(`step:${spanKey ?? ""}:${running.id}`, true) : null;
  const failed = tools.filter((t) => t.status === "failed").length;

  const summary = running ? `${friendlyStep(running, spaceName)}…` : workSummary(tools);
  // Under a second says nothing worth reading; the line shows a time once the work took one.
  const duration = span && span.ms >= 1000 ? (running ? elapsedText(span.ms) : formatDuration(span.ms)) : undefined;

  return (
    <div className="my-1" data-slot="work-group" data-live={running ? "" : undefined} role={running ? "status" : undefined} aria-live={running ? "polite" : undefined}>
      <ToolSummary
        summary={
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate">{summary}</span>
            {failed && !running ? <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-label={`${failed} failed`} /> : null}
          </span>
        }
        duration={duration}
        running={!!running}
        open={open}
        onOpenChange={setOpen}
      >
        <StepList variant="icon">
          {tools.map((t) => {
            const isFile = !!t.target && (t.category === "read" || t.category === "write");
            return (
              <Step
                key={t.id}
                state={stepState(t)}
                icon={ICON[t.category] ?? icons.step}
                tag={TAG[t.category] ?? undefined}
                detail={
                  technical && t.detail ? (
                    <StepDetail text={t.detail} />
                  ) : !technical && t.status === "failed" ? (
                    <p className="pb-1 text-destructive-foreground text-sm">This step didn’t work; Phaethon carried on without it.</p>
                  ) : undefined
                }
              >
                <span className="inline-flex min-w-0 max-w-full items-center gap-2">
                  <span className="shrink-0">{stepLabel(t, technical, spaceName)}</span>
                  {isFile ? (
                    <FileChip space={space} path={t.target!} className="min-w-0 rounded-full" />
                  ) : technical && t.target ? (
                    <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">{t.target}</span>
                  ) : null}
                  {t.status === "cancelled" || t.status === "incomplete" ? (
                    <Icon icon={icons.blocked} label={t.status === "cancelled" ? "stopped" : "unfinished"} className="size-3.5 text-subtle-foreground" />
                  ) : null}
                </span>
              </Step>
            );
          })}
        </StepList>
      </ToolSummary>
      {running ? <Patience hint={patienceHint(stepSpan?.ms ?? 0, running.category)} className="pl-8" /> : null}
      {running && technical ? <p className="truncate pl-8 font-mono text-subtle-foreground text-xs">{`${running.label}${running.target ? ` · ${running.target}` : ""}`}</p> : null}
    </div>
  );
}
