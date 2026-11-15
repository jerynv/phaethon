import { BookOpenText, FolderOpen, type Icon, MagnifyingGlass, PencilSimpleLine, Sparkle, TerminalWindow } from "@phosphor-icons/react";
import { CheckIcon, ChevronRightIcon, CircleSlashIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { ToolCategory } from "#shared/agent.ts";
import { FileChip } from "@/components/file-chip";
import { usePrefs } from "@/features/settings/prefs";
import { cn } from "@/lib/utils";
import { elapsedText, friendlyStep, patienceHint } from "../lib/progress";
import { workSummary, type ToolRecord } from "../lib/timeline";

/** One glyph per kind of step, readable without knowing what a tool is. */
const ICON: Record<ToolCategory, Icon> = {
  read: BookOpenText,
  list: FolderOpen,
  search: MagnifyingGlass,
  command: TerminalWindow,
  write: PencilSimpleLine,
  other: Sparkle,
};

/** When each running step was first seen in this window, so its own elapsed time survives re-renders. */
const firstSeen = new Map<string, number>();
function seenAt(id: string): number {
  let t = firstSeen.get(id);
  if (t === undefined) {
    t = Date.now();
    firstSeen.set(id, t);
    if (firstSeen.size > 500) firstSeen.delete(firstSeen.keys().next().value!);
  }
  return t;
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** Three dots that breathe in turn: the app is working, without a spinner's urgency. */
export function WorkingDots({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("inline-flex h-3 items-center gap-0.5", className)}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-1 rounded-full bg-primary"
          animate={{ opacity: [0.25, 1, 0.25], scale: [0.8, 1.15, 0.8] }}
          transition={{ duration: 1.2, repeat: Number.POSITIVE_INFINITY, delay: i * 0.18, ease: "easeInOut" }}
        />
      ))}
    </span>
  );
}

/**
 * The friendly line under a reply while Phaethon works: what it is doing in
 * plain words, how long this step has taken, and after a while a reassuring
 * second line. The words cross-fade when the step changes.
 */
export function ProgressLine({ text, since, category, technical }: { text: string; since?: number; category?: ToolCategory; technical?: string }) {
  const now = useNow(true);
  const ms = since ? now - since : 0;
  const hint = patienceHint(ms, category);
  return (
    <div className="my-1.5 flex flex-col gap-0.5" role="status" aria-live="polite" data-slot="progress-line">
      <div className="flex h-6 min-w-0 items-center gap-2 text-sm">
        <WorkingDots />
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={text}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="min-w-0 truncate font-medium text-shimmer"
          >
            {text}…
          </motion.span>
        </AnimatePresence>
        {since ? <span className="shrink-0 text-subtle-foreground text-xs tabular-nums">{elapsedText(ms)}</span> : null}
        {technical ? <span className="min-w-0 truncate font-mono text-2xs text-subtle-foreground">{technical}</span> : null}
      </div>
      <AnimatePresence initial={false}>
        {hint ? (
          <motion.span
            key={hint}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="pl-5 text-muted-foreground text-xs"
          >
            {hint}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function StepStatus({ t }: { t: ToolRecord }) {
  if (t.status === "running") return <WorkingDots className="shrink-0" />;
  if (t.status === "success") return <CheckIcon className="size-3 shrink-0 text-subtle-foreground" />;
  if (t.status === "failed") return <XIcon className="size-3 shrink-0 text-error" />;
  return <CircleSlashIcon className="size-3 shrink-0 text-subtle-foreground" aria-label={t.status === "cancelled" ? "stopped" : "unfinished"} />;
}

/**
 * Consecutive tool steps. While one runs: the friendly progress line. When
 * done: one quiet summary ("Read 3 files, searched twice") that opens to the
 * steps in plain words, each file a chip that opens it. Tool labels, raw
 * paths and output appear only with Settings › General › Show technical details.
 */
export function WorkGroup({ tools, live, space, spaceName }: { tools: ToolRecord[]; live: boolean; space: string; spaceName?: string }) {
  const technical = usePrefs((s) => s.technicalDetails);
  const running = live ? tools.find((t) => t.status === "running") : undefined;
  const [open, setOpen] = useState(false);
  const failed = tools.filter((t) => t.status === "failed").length;

  if (running) {
    return (
      <div data-slot="work-group" data-live="">
        <ProgressLine text={friendlyStep(running, spaceName)} since={seenAt(running.id)} category={running.category} technical={technical ? `${running.label}${running.target ? ` · ${running.target}` : ""}` : undefined} />
      </div>
    );
  }

  return (
    <div className="my-1" data-slot="work-group">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group/work -ml-1 flex h-6 max-w-full items-center gap-1.5 rounded-md px-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")} />
        <span className="min-w-0 truncate">{workSummary(tools)}</span>
        {failed ? <span className="size-1.5 shrink-0 rounded-full bg-error" aria-label={`${failed} failed`} /> : null}
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="ml-1.5 flex flex-col gap-0.5 overflow-hidden border-l pl-3"
          >
            {tools.map((t) => {
              const Glyph = ICON[t.category] ?? Sparkle;
              const isFile = !!t.target && (t.category === "read" || t.category === "write");
              return (
                <li key={t.id} className="flex min-w-0 flex-col py-0.5 first:mt-1">
                  <div className="flex min-w-0 items-center gap-2 text-xs">
                    <Glyph className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="shrink-0 text-foreground/85">{technical ? t.label : isFile ? (t.category === "read" ? (t.status === "running" ? "Reading" : "Read") : t.status === "running" ? "Writing" : "Wrote") : friendlyStep(t, spaceName)}</span>
                    {isFile ? (
                      <FileChip space={space} path={t.target!} variant="inline" className="min-w-0 text-xs" />
                    ) : technical && t.target ? (
                      <span className="min-w-0 truncate font-mono text-2xs text-muted-foreground">{t.target}</span>
                    ) : null}
                    <span className="flex-1" />
                    <StepStatus t={t} />
                  </div>
                  {technical && t.detail ? <p className="mt-0.5 ml-5.5 line-clamp-3 font-mono text-2xs text-muted-foreground wrap-anywhere">{t.detail}</p> : null}
                  {!technical && t.status === "failed" ? <p className="mt-0.5 ml-5.5 text-error-foreground text-xs">This step didn’t work; Phaethon carried on without it.</p> : null}
                </li>
              );
            })}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
