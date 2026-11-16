import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { ToolCategory } from "#shared/agent.ts";
import { FileChip } from "@/components/file-chip";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { Spinner } from "@/components/ui/spinner";
import { ToolSummary, formatDuration } from "@/components/ui/step-list";
import { commandIsCut, WorkLogCommand, WorkLogCommandBody, WorkLogDetails, WorkLogList, WorkLogRow } from "@/components/ui/work-log";
import { usePrefs } from "@/features/settings/prefs";
import { cn } from "@/lib/utils";
import { elapsedText, friendlyStep, patienceHint } from "../lib/progress";
import { workSummary, type ToolRecord } from "../lib/timeline";

/** One glyph per kind of step, readable without knowing what a tool is (docs/UI-REBUILD.md › Icons). */
const ICON: Record<ToolCategory, IconData> = {
  read: icons.read,
  list: icons.list,
  search: icons.search,
  command: icons.terminal,
  write: icons.write,
  other: icons.step,
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
          className={cn("block text-subtle-foreground text-xs", className)}
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
/** "Waiting for you": the amber dot that replaces the spinner while a card above the composer needs an answer. */
function WaitingDot() {
  return <span className="size-1.5 rounded-full bg-warning" aria-hidden />;
}

export function ProgressLine({ text, since, category, technical, waiting = false }: { text: string; since?: number; category?: ToolCategory; technical?: string; waiting?: boolean }) {
  const now = useNow(!waiting);
  const ms = since ? now - since : 0;
  if (waiting) {
    return (
      <div className="my-1 flex h-8 min-w-0 items-center gap-2 px-0.5 text-muted-foreground text-sm" role="status" data-slot="progress-line" data-waiting="">
        <span className="flex w-5 shrink-0 justify-center">
          <WaitingDot />
        </span>
        Waiting for you
      </div>
    );
  }
  return (
    <div className="my-1 flex flex-col" role="status" aria-live="polite" data-slot="progress-line">
      <div className="flex h-8 min-w-0 items-center gap-2 px-0.5 text-muted-foreground text-sm">
        <span className="flex w-5 shrink-0 justify-center">
          <Spinner size="sm" className="text-subtle-foreground" />
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
        {since ? <span className="ml-auto shrink-0 text-subtle-foreground text-xs tabular-nums">{elapsedText(ms)}</span> : null}
      </div>
      <Patience hint={patienceHint(ms, category)} className="pl-7.5" />
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
  if (t.category === "command") return t.status === "running" ? "Running a command" : "Ran a command";
  const isFile = !!t.target && (t.category === "read" || t.category === "write");
  if (!isFile) return friendlyStep(t, spaceName);
  if (t.category === "read") return t.status === "running" ? "Reading" : "Read";
  return t.status === "running" ? "Writing" : "Wrote";
}

/** A tool's raw output (Settings › Show technical details): a quiet code-like block. */
function StepDetail({ text }: { text: string }) {
  return <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-code px-3 py-2 font-mono text-muted-foreground text-xs wrap-anywhere">{text}</pre>;
}

/** The command a step ran. Older records and Phaethon's own tools may carry only a label ("Running ls"). */
function commandOf(t: ToolRecord): string | null {
  if (t.target?.trim()) return t.target;
  const rest = t.label.replace(/^(Ran|Running)\s+/i, "").trim();
  return rest && !/^(a\s+)?command$/i.test(rest) ? rest : null;
}

/**
 * Consecutive tool steps (refs 7cad, 95ba). One summary line ("Read 3 files,
 * ran a command … 4s") that opens to the steps, one quiet line each after T3
 * Code's work log: a small muted glyph and the step in plain words, each file
 * a chip that opens it. A command shows the command line itself (mono, cut to
 * one line) and opens to the whole command and what it printed. While a step
 * runs the line says what it is doing in plain words, with a shimmer, the
 * elapsed time and after a while a reassuring second line. Other tools' labels,
 * raw paths and output appear only with Settings › General › Show technical
 * details.
 */
export function WorkGroup({
  tools,
  live,
  space,
  spaceName,
  spanKey,
  waiting = false,
}: {
  tools: ToolRecord[];
  live: boolean;
  space: string;
  spaceName?: string;
  spanKey?: string;
  /** A card under this reply needs an answer: the line stops spinning and counting and says so. */
  waiting?: boolean;
}) {
  const technical = usePrefs((s) => s.technicalDetails);
  const running = live ? tools.find((t) => t.status === "running") : undefined;
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<Record<string, boolean>>({});
  // Open commands whose row cut the command short: those show it whole above their output.
  const [cut, setCut] = useState<Record<string, boolean>>({});
  const span = trackSpan(`work:${spanKey ?? tools[0]?.id ?? ""}`, !!running);
  useNow(!!running);
  const stepSpan = running ? trackSpan(`step:${spanKey ?? ""}:${running.id}`, true) : null;
  const failed = tools.filter((t) => t.status === "failed").length;

  const held = !!running && waiting;
  const summary = held ? "Waiting for you" : running ? `${friendlyStep(running, spaceName)}…` : workSummary(tools);
  // Under a second says nothing worth reading; the line shows a time once the work took one.
  const duration = held ? undefined : span && span.ms >= 1000 ? (running ? elapsedText(span.ms) : formatDuration(span.ms)) : undefined;

  return (
    <div className={cn("my-1 transition-[margin]", open && "mb-2")} data-slot="work-group" data-live={running ? "" : undefined} role={running ? "status" : undefined} aria-live={running ? "polite" : undefined}>
      <ToolSummary
        summary={
          <span className="inline-flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate">{summary}</span>
            {failed && !running ? <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-label={`${failed} failed`} /> : null}
          </span>
        }
        duration={duration}
        running={!!running && !held}
        lead={held ? <WaitingDot /> : undefined}
        open={open}
        onOpenChange={setOpen}
      >
        <WorkLogList>
          {tools.map((t) => {
            const isFile = !!t.target && (t.category === "read" || t.category === "write");
            const command = t.category === "command" ? commandOf(t) : null;
            const active = t.status === "running";
            const stopped =
              t.status === "cancelled" || t.status === "incomplete" ? (
                <Icon icon={icons.blocked} label={t.status === "cancelled" ? "stopped" : "unfinished"} className="size-3.5 shrink-0 text-subtle-foreground" />
              ) : null;
            if (command !== null) {
              return (
                <WorkLogRow
                  key={t.id}
                  icon={icons.terminal}
                  state={stepState(t)}
                  label={<WorkLogCommand command={command} active={active} />}
                  accessibleLabel={`${active ? "Running" : "Ran"} ${command}${t.status === "failed" ? ", didn’t work" : ""}`}
                  trailing={stopped}
                  expanded={!!shown[t.id]}
                  onExpandedChange={(o, line) => {
                    if (o) setCut((c) => ({ ...c, [t.id]: commandIsCut(line, command) }));
                    setShown((s) => ({ ...s, [t.id]: o }));
                  }}
                >
                  <WorkLogDetails>
                    <WorkLogCommandBody command={command} output={t.detail === "Tool reported an error" ? undefined : t.detail} running={active} full={cut[t.id] ?? true} />
                  </WorkLogDetails>
                </WorkLogRow>
              );
            }
            // A command saved before its line was kept shows only that it ran, and what it printed.
            const detail = (t.category === "command" || technical) && t.detail && t.detail !== "Tool reported an error" ? <StepDetail text={t.detail} /> : null;
            return (
              <WorkLogRow
                key={t.id}
                icon={ICON[t.category] ?? icons.step}
                state={stepState(t)}
                label={
                  <>
                    <span className={cn("shrink-0", active && "text-shimmer")}>{stepLabel(t, technical, spaceName)}</span>
                    {isFile ? (
                      <FileChip space={space} path={t.target!} className="h-6 min-w-0 rounded-md text-muted-foreground hover:text-foreground" />
                    ) : technical && t.target ? (
                      <span className="min-w-0 truncate font-mono text-subtle-foreground text-xs">{t.target}</span>
                    ) : null}
                    {!technical && t.status === "failed" ? <span className="min-w-0 truncate text-destructive-foreground text-xs">didn’t work, carried on without it</span> : null}
                  </>
                }
                trailing={stopped}
                expanded={!!shown[t.id]}
                onExpandedChange={detail ? (o) => setShown((s) => ({ ...s, [t.id]: o })) : undefined}
              >
                {detail ? <WorkLogDetails>{detail}</WorkLogDetails> : null}
              </WorkLogRow>
            );
          })}
        </WorkLogList>
      </ToolSummary>
      {running && !held ? <Patience hint={patienceHint(stepSpan?.ms ?? 0, running.category)} className="pl-7.5" /> : null}
      {running && technical ? <p className="truncate pl-7.5 font-mono text-subtle-foreground text-xs">{`${running.label}${running.target ? ` · ${running.target}` : ""}`}</p> : null}
    </div>
  );
}
