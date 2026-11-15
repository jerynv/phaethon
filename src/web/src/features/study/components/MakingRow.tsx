import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Truncate } from "@/components/truncate";
import { cn } from "@/lib/utils";
import { type MakeJob, useMakeJobs } from "../jobs";
import { stages } from "../lib/make-flow";

/**
 * A quiz or deck being made, as one row: its name, a thin progress bar, the
 * stage it is at in plain words, how long it has run, and Stop. Study's
 * overview lists every run in the space with it; a chat card shows its own.
 */
export function MakingRow({ job, showTitle = true, className }: { job: MakeJob; showTitle?: boolean; className?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const quiz = job.kind === "quiz";
  const stopping = job.status === "stopping";
  const stage = stages(job.progress, { quiz, course: job.courseName, exam: job.exam }).find((s) => s.state === "active");
  const secs = Math.max(0, Math.round((now - job.started) / 1000));
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)} data-testid="making-row" aria-live="polite">
      <div className="flex min-w-0 items-center gap-2">
        <Icon icon={quiz ? icons.quiz : icons.deck} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          {showTitle ? <Truncate className="text-sm">{job.title}</Truncate> : null}
          <span className={cn("block truncate text-xs", stopping ? "text-muted-foreground" : "text-shimmer")}>{stopping ? "Stopping…" : (stage?.detail ?? stage?.label ?? (quiz ? "Making your quiz…" : "Making your cards…"))}</span>
        </span>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{clock}</span>
        <Button size="xs" variant="ghost-muted" disabled={stopping} onClick={() => void useMakeJobs.getState().stop(job.id)}>
          Stop
        </Button>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.fraction * 100)}>
        <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${Math.max(2, job.fraction * 100)}%` }} />
      </div>
    </div>
  );
}
