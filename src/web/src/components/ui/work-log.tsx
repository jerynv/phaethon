// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT. See THIRD_PARTY_NOTICES.md. After its timeline work log (WorkLog.tsx, TimelineWorkEntryRow.tsx, ShellCommandBlock.tsx).
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type * as React from "react";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

/**
 * An agent's steps, one quiet line each (docs/UI-REBUILD.md › Chat timeline):
 *
 *   <WorkLogList>
 *     <WorkLogRow icon={icons.terminal} label={<WorkLogCommand command="git status" />} expanded onExpandedChange>
 *       <WorkLogDetails><WorkLogCommandBody command="git status" output="…" /></WorkLogDetails>
 *     </WorkLogRow>
 *   </WorkLogList>
 *
 * A row is a small muted glyph and one truncated line; a row with more to
 * show takes a chevron and opens under itself, indented to the text. The row
 * is a div, so a file chip or a selection inside it keeps working.
 */

export type WorkLogState = "done" | "active" | "failed" | "pending";

export function WorkLogList({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <ul data-slot="work-log" className={cn("flex min-w-0 flex-col py-1", className)}>
      {children}
    </ul>
  );
}

export function WorkLogRow({
  icon,
  state = "done",
  label,
  trailing,
  expanded = false,
  onExpandedChange,
  accessibleLabel,
  children,
  className,
}: {
  icon: IconData;
  state?: WorkLogState;
  label: React.ReactNode;
  /** Small things after the label (a stopped mark). The chevron comes last on its own. */
  trailing?: React.ReactNode;
  expanded?: boolean;
  /** Makes the row open and close; without it the row is plain text. Gets the row's line, to measure what it shows. */
  onExpandedChange?: (expanded: boolean, line: HTMLElement) => void;
  /** The row's name for assistive tech when the label is more than words. */
  accessibleLabel?: string;
  /** What shows under the row while it is open (`WorkLogDetails`). */
  children?: React.ReactNode;
  className?: string;
}) {
  const interactive = !!onExpandedChange;
  const toggle = (line: HTMLElement) => onExpandedChange?.(!expanded, line);
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      data-slot="work-log-row"
      data-state={state}
      className={cn("min-w-0", className)}
    >
      <div
        {...(interactive
          ? {
              role: "button",
              tabIndex: 0,
              "aria-expanded": expanded,
              "aria-label": accessibleLabel,
              onClick: (e: React.MouseEvent<HTMLDivElement>) => toggle(e.currentTarget),
              onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  toggle(e.currentTarget);
                }
              },
            }
          : {})}
        className={cn(
          "group/work-row flex min-h-7 min-w-0 items-center gap-2 rounded-md px-0.5 text-muted-foreground text-sm outline-none transition-colors",
          interactive && "cursor-pointer hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        )}
      >
        <span className="flex w-5 shrink-0 items-center justify-center" aria-hidden={state !== "failed"}>
          {state === "active" ? (
            <Spinner size="sm" className="text-subtle-foreground" />
          ) : (
            <Icon
              icon={icon}
              label={state === "failed" ? "didn’t work" : undefined}
              className={cn("size-4", state === "failed" ? "text-destructive-foreground" : "text-subtle-foreground transition-colors group-hover/work-row:text-muted-foreground")}
            />
          )}
        </span>
        <span className={cn("flex min-w-0 flex-1 items-center gap-2", state === "pending" && "text-subtle-foreground")}>{label}</span>
        {trailing}
        {interactive ? (
          <Icon icon={icons.chevronRight} className={cn("size-3 shrink-0 text-subtle-foreground transition-transform duration-200", expanded && "rotate-90")} />
        ) : null}
      </div>
      <Reveal open={expanded && !!children}>{children}</Reveal>
    </motion.li>
  );
}

function Reveal({ open, children }: { open: boolean; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="details"
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

/** Under an open row, indented to its text. Clicks inside don't close the row, and text in it can be selected. */
export function WorkLogDetails({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("cursor-auto select-text pt-0.5 pb-2 pl-7.5", className)} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

/** A command as a row's label: mono, one line, cut at the end. */
export function WorkLogCommand({ command, active = false }: { command: string; active?: boolean }) {
  return (
    <code data-slot="work-log-command" className={cn("min-w-0 truncate font-mono text-xs", active && "text-shimmer")}>
      {command.replace(/\s+/g, " ").trim()}
    </code>
  );
}

/** Whether a row's command line shows less than the whole command (cut short, or a script over several lines). */
export function commandIsCut(line: HTMLElement, command: string): boolean {
  const code = line.querySelector<HTMLElement>('[data-slot="work-log-command"]');
  return command.trim().includes("\n") || (!!code && code.scrollWidth > code.clientWidth + 1);
}

/** An open command: the whole command line when the row cut it short, then what it printed (scrolls past 20 lines), or that it printed nothing. */
export function WorkLogCommandBody({ command, output, running = false, full = true }: { command: string; output?: string; running?: boolean; full?: boolean }) {
  const printed = output ? (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap px-3 py-2 text-muted-foreground wrap-anywhere">{output}</pre>
  ) : running ? null : (
    <p className="px-3 py-2 text-subtle-foreground italic">No output</p>
  );
  if (!full && !printed) return null;
  return (
    <div className="flex min-w-0 flex-col divide-y rounded-lg bg-code font-mono text-xs leading-5">
      {full ? (
        <pre className="whitespace-pre-wrap px-3 py-2 text-foreground/85 wrap-anywhere">
          <span className="select-none text-subtle-foreground">$ </span>
          {command.trim()}
        </pre>
      ) : null}
      {printed}
    </div>
  );
}
