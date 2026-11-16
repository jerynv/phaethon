import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import * as React from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

/**
 * How an agent's work reads in the timeline (docs/UI-REBUILD.md › Chat):
 *
 *   <ThoughtToggle state="done" label="Thought 12s" open onOpenChange />
 *   <StepList open>
 *     <Step state="done">Searching last 7 days of notes</Step>
 *     <Step state="active">Building the summary…</Step>
 *   </StepList>
 *
 *   <ToolSummary summary="18 tools, edited 5 files, ran 2 commands" duration="6m 12s" open onOpenChange>
 *     <WorkLogList>…</WorkLogList>   (components/ui/work-log.tsx)
 *   </ToolSummary>
 *
 * Steps hang off a 1 px rail with dot bullets; the running step spins, a
 * failed one turns red. Lists open and close with a height spring.
 */

/** "6m 12s", "12s", "1h 4m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export type StepState = "done" | "active" | "pending" | "failed";

function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="steps"
          initial={reduce ? false : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 40, opacity: { duration: 0.15 } }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** A filled dark disc with a white tick: the references' "done thinking" mark. */
function DoneDisc({ className }: { className?: string }) {
  return (
    <span className={cn("flex size-3.5 items-center justify-center rounded-full bg-foreground/75 text-background", className)}>
      <Icon icon={icons.check} className="size-2.5" />
    </span>
  );
}

/** The "Thinking… / Thought 12s ⌄" pill that opens a reply's reasoning steps. */
function ThoughtToggle({
  state,
  label,
  open,
  onOpenChange,
  className,
}: {
  state: "thinking" | "done" | "failed";
  label: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-slot="thought-toggle"
      data-state={state}
      aria-expanded={open}
      onClick={() => onOpenChange(!open)}
      className={cn(
        "inline-flex h-7 w-fit items-center gap-1.5 rounded-full border bg-card pr-2 pl-2 text-muted-foreground text-sm outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={state}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.6, opacity: 0 }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
          className="flex"
        >
          {state === "thinking" ? <Spinner size="sm" /> : state === "failed" ? <Icon icon={icons.failed} className="size-3.5 text-destructive-foreground" /> : <DoneDisc />}
        </motion.span>
      </AnimatePresence>
      <span className={cn(state === "thinking" && "text-shimmer")}>{label}</span>
      <Icon icon={icons.chevronDown} className={cn("size-3.5 transition-transform duration-200", !open && "-rotate-90")} />
    </button>
  );
}

/** The steps, on a rail. `open` animates the list in and out. */
function StepList({ open = true, className, children }: { open?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <Collapse open={open}>
      <ol data-slot="step-list" className={cn("flex flex-col py-1.5 pl-1", className)}>
        {children}
      </ol>
    </Collapse>
  );
}

function Step({
  state = "done",
  meta,
  children,
  detail,
  wrap = false,
  className,
}: {
  state?: StepState;
  /** Let long text wrap onto more lines (reasoning in words) instead of truncating to one. */
  wrap?: boolean;
  /** Trailing muted text (a time, a count). */
  meta?: React.ReactNode;
  children: React.ReactNode;
  /** Content under the step, still on the rail (a JSON block, file chips). */
  detail?: React.ReactNode;
  className?: string;
}) {
  const marker =
    state === "active" ? (
      <Spinner size="xs" className="text-muted-foreground" />
    ) : (
      <span className={cn("size-1.5 rounded-full", state === "failed" ? "bg-destructive" : state === "pending" ? "border border-subtle-foreground" : "bg-subtle-foreground")} />
    );
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      data-slot="step"
      data-state={state}
      className={cn("group/step relative flex flex-col", className)}
    >
      {/* The rail runs from this marker to the next one; the last step has none. */}
      <span
        aria-hidden
        className={cn(
          "absolute top-0 bottom-0 left-2.5 w-px -translate-x-1/2 bg-border group-first/step:top-4 group-last/step:bottom-auto group-last/step:h-4 group-only/step:hidden",
        )}
      />
      <div className={cn("flex gap-3", wrap ? "items-start" : "items-center")}>
        <span className="relative z-10 flex h-8 w-5 shrink-0 items-center justify-center">
          <span className="flex bg-background py-1">{marker}</span>
        </span>
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 text-muted-foreground text-sm",
            wrap ? "min-h-8 py-1.5" : "h-8",
            state === "pending" && "text-subtle-foreground",
          )}
        >
          {/* The shimmer paints plain text only; a step that passes its own elements (a label and a file chip) shimmers its label itself. */}
          <span className={cn("min-w-0 flex-1", wrap ? "wrap-anywhere" : "truncate", state === "active" && typeof children === "string" && "text-shimmer")}>{children}</span>
          {meta ? <span className="shrink-0 text-subtle-foreground text-xs tabular-nums">{meta}</span> : null}
        </span>
      </div>
      {detail ? <div className="relative z-10 pb-2 pl-8">{detail}</div> : null}
    </motion.li>
  );
}

/** "✳ 18 tools, edited 5 files, ran 2 commands ⌄ ……… 6m 12s", opening to its steps. */
function ToolSummary({
  summary,
  duration,
  running = false,
  lead,
  open,
  onOpenChange,
  children,
  className,
}: {
  summary: React.ReactNode;
  duration?: React.ReactNode;
  running?: boolean;
  /** Replaces the leading glyph (a status dot while the work waits on the person). */
  lead?: React.ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="tool-summary" className={cn("flex flex-col", className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="group/summary flex h-8 items-center gap-2 rounded-lg px-0.5 text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex w-5 shrink-0 justify-center">
          {lead ?? (running ? <Spinner size="sm" className="text-subtle-foreground" /> : <Icon icon={icons.step} className="size-4 text-subtle-foreground transition-colors group-hover/summary:text-muted-foreground" />)}
        </span>
        <span className={cn("min-w-0 truncate text-sm", running && "text-shimmer")}>{summary}</span>
        <Icon icon={icons.chevronRight} className={cn("size-3 shrink-0 text-subtle-foreground transition-transform duration-200", open && "rotate-90")} />
        {duration ? <span className="ml-auto shrink-0 text-subtle-foreground text-xs tabular-nums">{duration}</span> : null}
      </button>
      {children ? <Collapse open={open}>{children}</Collapse> : null}
    </div>
  );
}

export { Step, StepList, ThoughtToggle, ToolSummary };
